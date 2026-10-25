import { describe, expect, it } from "vitest";
import { WHATSAPP_TEXT, fill } from "../../copy";
import type { NewOf } from "../../connector/codec";
import type { Evidence } from "../../domain/case-items";
import { gatewayContext } from "../common/principal";
import { GATEWAY_TOOLS } from "../common/targets";
import { CUSTOMER, WORLD } from "../common/testing";
import { createActionsTarget } from "../actions/handler";
import { effectWorld } from "../actions/testing";
import { createMessagingTarget } from "../messaging/handler";
import { createHandoffTarget } from "./handler";

const ABOVE_AGENT_CAP = 31_240_000;

function settlementMatch(amount: number): NewOf<typeof Evidence>["details"] {
  return {
    result: "MATCHED",
    source: "SETTLEMENT",
    line: { network: "NORTE", businessDate: "2026-10-07", operationCode: "NTE-20261006-004817-7", paidAt: "2026-10-06T18:40:00-03:00", amount, customerRef: CUSTOMER, loanRef: "L-0001", instalment: 4, terminal: "T-0412" },
  };
}

async function handoffWorld() {
  const world = await effectWorld();
  const target = createHandoffTarget(world.deps, { gate: world.gate.gate, complaints: world.complaintsDeps });
  const actions = createActionsTarget(world.deps, { core: () => world.core.client, networks: () => world.networks.client, complaints: world.complaintsDeps });
  const call = (tool: string, token: string, input: Record<string, unknown>) => target.handle({ sessionToken: token, ...input }, gatewayContext(`handoff___${tool}`));
  const act = (tool: string, token: string, input: Record<string, unknown>) => actions.handle({ sessionToken: token, ...input }, gatewayContext(`actions___${tool}`));
  return Object.assign(world, { call, act });
}

type World = Awaited<ReturnType<typeof handoffWorld>>;

/** A payment complaint with a MATCHED reconciliation above the agent's cap, identified, the action refused ABOVE_CAP. */
async function aboveCapCase(world: World, eventId = "evt-approval-1", status?: "HUMAN_REVIEW") {
  const complaint = await world.addComplaint(status === undefined ? {} : { status });
  await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-rec-big", refId: "rcn-big", kind: "SETTLEMENT_MATCH", details: settlementMatch(ABOVE_AGENT_CAP) });
  const turn = await world.openTurn({ complaintIds: [complaint.complaintId], eventId });
  await world.identify();
  expect(await world.act("apply_payment", turn.token, { reconciliationId: "rcn-big" })).toMatchObject({ ok: false, error: { code: "ABOVE_CAP" }, capTier: "OPERATOR" });
  return { complaint, turn };
}

describe("escalate_to_human [FL-060] [FL-061]", () => {
  it("[FL-060] the customer asked for a person: the open complaint goes to HUMAN_REVIEW with its task, and the code sends the fixed HANDOFF_NOTICE", async () => {
    const world = await handoffWorld();
    const complaint = await world.addComplaint({ status: "INVESTIGATING" });
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    const answer = await world.call("escalate_to_human", turn.token, { reason: "CUSTOMER_ASKED", summary: "Pide hablar con una persona; dejó su CBU 0110599940000041234567" });
    expect(answer).toMatchObject({ ok: true, status: "HUMAN_REVIEW" });

    const after = await world.connector.complaints.get(WORLD, complaint.complaintId);
    expect(after).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "CUSTOMER_ASKED" }, priority: "NORMAL" });
    expect(after?.handoff?.summary).not.toContain("0110599940000041234567");
    const register = await world.connector.chains.listRegisterByComplaint(WORLD, 1, complaint.complaintNumber);
    expect(register.map((entry) => entry.reason)).toContain("HANDOFF_CUSTOMER_ASKED");
    const tasks = (await world.connector.caseItems.listNotes(WORLD, complaint.complaintId)).filter((note) => note.kind === "HUMAN_TASK");
    expect(tasks).toEqual([expect.objectContaining({ task: expect.objectContaining({ status: "OPEN", route: "HUMAN_QUEUE" }) })]);
    expect(tasks[0]?.text).not.toContain("0110599940000041234567");

    expect(world.gate.sent).toHaveLength(1);
    const { request, call } = world.gate.sent[0] ?? { request: undefined, call: undefined };
    expect(request).toMatchObject({
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind: "HANDOFF_NOTICE",
      customerId: CUSTOMER,
      complaintId: complaint.complaintId,
      text: fill(WHATSAPP_TEXT.HANDOFF_NOTICE, { complaintNumber: complaint.complaintNumber, deadlineText: "jueves 22/10" }),
    });
    expect(call?.actor).toBe("AGENT");
    expect((answer as unknown as { handoffNoticeMessageId: string }).handoffNoticeMessageId).toBe(request?.messageId);
    expect((await world.auditRows()).find((row) => row.action === "ESCALATED")).toMatchObject({ outcome: "CUSTOMER_ASKED" });
  });

  it("[FL-060] a retried call keeps one task and asks the gate for the same notice (its send claim answers it once)", async () => {
    const world = await handoffWorld();
    const complaint = await world.addComplaint({ status: "INVESTIGATING" });
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    const input = { reason: "CUSTOMER_ASKED", summary: "Pide hablar con una persona" };
    expect(await world.call("escalate_to_human", turn.token, input)).toMatchObject({ ok: true });
    expect(await world.call("escalate_to_human", turn.token, input)).toMatchObject({ ok: true, status: "HUMAN_REVIEW" });
    expect((await world.connector.caseItems.listNotes(WORLD, complaint.complaintId)).filter((note) => note.kind === "HUMAN_TASK")).toHaveLength(1);
    const ids = world.gate.sent.map((item) => item.request.messageId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
  });

  it("[FL-060] without a complaint the conversation gets a human task and the fixed notice; no identification is needed", async () => {
    const world = await handoffWorld();
    const turn = await world.openTurn();
    expect(await world.call("escalate_to_human", turn.token, { reason: "CUSTOMER_ASKED", summary: "Quiere hablar con alguien antes de contar el problema" })).toMatchObject({ ok: true, status: "HUMAN_REVIEW" });
    expect(await world.connector.conversations.listTasks(WORLD, CUSTOMER)).toEqual([expect.objectContaining({ task: expect.objectContaining({ status: "OPEN", route: "HUMAN_QUEUE" }) })]);
    expect(world.gate.sent[0]?.request).toMatchObject({ sender: "SYSTEM", kind: "HANDOFF_NOTICE", text: WHATSAPP_TEXT.HANDOFF_NOTICE_NO_COMPLAINT });
    expect(world.gate.sent[0]?.request.complaintId).toBeUndefined();
  });

  it("[FL-061] low confidence or two failed attempts: HUMAN_REVIEW with the reason; a blocked notice never undoes the handoff", async () => {
    for (const reason of ["LOW_CONFIDENCE", "TWO_FAILED_ATTEMPTS"] as const) {
      const world = await handoffWorld();
      const complaint = await world.addComplaint({ status: "AWAITING_CUSTOMER" });
      const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
      world.gate.answerWith(() => ({ ok: false, ruleIds: [], failure: { ok: false, error: { code: "UNAVAILABLE", message: "down" } } }));
      expect(await world.call("escalate_to_human", turn.token, { reason, summary: "No pude resolverlo en dos intentos" })).toMatchObject({ ok: true, status: "HUMAN_REVIEW" });
      expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason } });
      expect(world.gate.sent.map((item) => item.request.kind)).toEqual(["HANDOFF_NOTICE"]);
    }
  });

  it("[FL-049] FRAUD raises the priority, sends the fixed safety guidance (with the freeze notice) and alerts a supervisor", async () => {
    const world = await handoffWorld();
    const complaint = await world.addComplaint({ type: "UNKNOWN_OPERATION", status: "INVESTIGATING" });
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    await world.identify();
    expect(await world.act("freeze_outgoing", turn.token, { reason: "UNKNOWN_OPERATION" })).toMatchObject({ ok: true });
    expect(await world.call("escalate_to_human", turn.token, { reason: "FRAUD", summary: "Transferencia que el cliente no reconoce" })).toMatchObject({ ok: true, status: "HUMAN_REVIEW" });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "HUMAN_REVIEW", priority: "HIGH", handoff: { reason: "FRAUD" } });
    expect(world.gate.sent.map((item) => item.request.kind)).toEqual(["SAFETY_GUIDANCE", "HANDOFF_NOTICE"]);
    expect(world.gate.sent[0]?.request.text).toBe(`${WHATSAPP_TEXT.SAFETY_GUIDANCE_FREEZE}\n\n${WHATSAPP_TEXT.SAFETY_GUIDANCE}`);
    expect((await world.auditRows()).find((row) => row.action === "SUPERVISOR_ALERT")).toMatchObject({ outcome: "FRAUD" });
  });

  it("two open complaints without complaintId is ambiguous; another session's complaint is FORBIDDEN; a closed one cannot be handed over", async () => {
    const world = await handoffWorld();
    const first = await world.addComplaint({ status: "INVESTIGATING" });
    const second = await world.addComplaint({ status: "INVESTIGATING" });
    const closed = await world.addComplaint({ status: "CLOSED" });
    const foreign = await world.addComplaint({ customerId: "cus-0002" });
    const turn = await world.openTurn({ complaintIds: [first.complaintId, second.complaintId, closed.complaintId] });
    const escalate = (input: Record<string, unknown>) => world.call("escalate_to_human", turn.token, { reason: "OTHER", summary: "Necesita revisión", ...input });
    expect(await escalate({})).toMatchObject({ ok: false, error: { code: "INVALID", reason: "AMBIGUOUS_COMPLAINT" } });
    expect(await escalate({ complaintId: foreign.complaintId })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await escalate({ complaintId: closed.complaintId })).toMatchObject({ ok: false, error: { code: "NOT_ELIGIBLE", reason: "NOT_ESCALABLE" } });
    expect(await escalate({ complaintId: second.complaintId })).toMatchObject({ ok: true });
    expect(await world.connector.complaints.get(WORLD, first.complaintId)).toMatchObject({ status: "INVESTIGATING" });
    expect(await world.connector.complaints.get(WORLD, second.complaintId)).toMatchObject({ status: "HUMAN_REVIEW" });
  });
});

describe("request_operator_approval [FL-024] [FL-088]", () => {
  it("[FL-024] after ABOVE_CAP: a PENDING approval whose action, amount and tier the code fixed; AWAITING_APPROVAL; the fixed update", async () => {
    const world = await handoffWorld();
    const { complaint, turn } = await aboveCapCase(world);
    const answer = await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-big", justification: "El pago figura en la rendición publicada" });
    expect(answer).toMatchObject({ ok: true, capTier: "OPERATOR", amount: { amount: 312_400, text: "$ 312.400,00" }, status: "PENDING" });
    const { approvalId } = answer as unknown as { approvalId: string };

    const file = await world.connector.caseItems.caseFile(WORLD, complaint.complaintId);
    expect(file.approvals).toEqual([
      expect.objectContaining({ approvalId, action: "APPLY_PAYMENT", amountCents: ABOVE_AGENT_CAP, capTier: "OPERATOR", decision: "PENDING", evidenceId: "evd-rec-big", requestedBy: "AGENT", epoch: 1, expiresAtSim: "2026-10-09T10:10:00-03:00" }),
    ]);
    expect(file.actions).toEqual([]);
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "AWAITING_APPROVAL" });

    expect(world.gate.sent.map((item) => item.request)).toEqual([
      expect.objectContaining({ sender: "SYSTEM", kind: "COMPLAINT_UPDATE", complaintId: complaint.complaintId, text: fill(WHATSAPP_TEXT.APPROVAL_PENDING, { complaintNumber: complaint.complaintNumber }) }),
    ]);
    expect((await world.auditRows()).find((row) => row.action === "APPROVAL_REQUESTED")).toMatchObject({ outcome: "PENDING", refs: expect.objectContaining({ approvalId, capTier: "OPERATOR" }) });

    // Asked again, the pending approval answers: no second approval, no second update.
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "evd-rec-big", justification: "Otra vez" })).toMatchObject({ ok: true, approvalId });
    expect((await world.connector.caseItems.caseFile(WORLD, complaint.complaintId)).approvals).toHaveLength(1);
    expect(world.gate.sent).toHaveLength(1);
  });

  it("[FL-024] a complaint a person already holds (HUMAN_REVIEW) still reaches AWAITING_APPROVAL with its pending approval", async () => {
    const world = await handoffWorld();
    const { complaint, turn } = await aboveCapCase(world, "evt-approval-hr", "HUMAN_REVIEW");
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-big", justification: "El pago figura en la rendición publicada" })).toMatchObject({ ok: true, capTier: "OPERATOR", status: "PENDING" });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect((await world.connector.caseItems.caseFile(WORLD, complaint.complaintId)).approvals.map((approval) => approval.decision)).toEqual(["PENDING"]);
  });

  it("[FL-024] without an ABOVE_CAP of the same evidence it is NOT_ELIGIBLE, and an evidence that founds no money action is refused", async () => {
    const world = await handoffWorld();
    const complaint = await world.addComplaint();
    await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-rec-small", refId: "rcn-small", kind: "SETTLEMENT_MATCH", details: settlementMatch(ABOVE_AGENT_CAP) });
    await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-read", refId: "rdg-1", kind: "RECEIPT_READING", details: { result: "READ" } });
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-small", justification: "Pedido sin tope previo" })).toMatchObject({ ok: false, error: { code: "NOT_ELIGIBLE", reason: "NO_ABOVE_CAP" } });
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rdg-1", justification: "Lectura" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED", reason: "EVIDENCE_KIND" } });
    expect((await world.connector.caseItems.caseFile(WORLD, complaint.complaintId)).approvals).toEqual([]);
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "REGISTERED" });
  });

  it("[FL-088] the agent cannot approve: decision is refused with any value, no tool approves, the approval stays PENDING and nothing moves", async () => {
    const world = await handoffWorld();
    const { complaint, turn } = await aboveCapCase(world);
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-big", justification: "Pedido" })).toMatchObject({ ok: true, status: "PENDING" });
    for (const decision of ["APPROVED", "approved", ""]) {
      expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-big", justification: "Aprobado", decision })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    const denied = (await world.auditRows()).filter((row) => row.action === "DENY" && row.refs["deniedTool"] === "REQUEST_OPERATOR_APPROVAL");
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((row) => row.ruleIds?.includes("LAM-STRICT"))).toBe(true);

    const file = await world.connector.caseItems.caseFile(WORLD, complaint.complaintId);
    expect(file.approvals.map((approval) => approval.decision)).toEqual(["PENDING"]);
    expect(file.approvals[0]?.decidedBy).toBeUndefined();
    expect(file.actions).toEqual([]);
    const tools = Object.values(GATEWAY_TOOLS).flat() as string[];
    expect(tools.filter((tool) => /approv|decid/.test(tool))).toEqual(["request_operator_approval"]);
  });

  it("the update counts as the event's one COMPLAINT_UPDATE: after the agent sent one, the approval is created and no second update goes out", async () => {
    const world = await handoffWorld();
    const messaging = createMessagingTarget(world.deps, { gate: world.gate.gate });
    const { complaint, turn } = await aboveCapCase(world, "evt-approval-2");
    const update = { sessionToken: turn.token, kind: "COMPLAINT_UPDATE", text: "Estamos revisando tu pago.", complaintId: complaint.complaintId };
    expect(await messaging.handle(update, gatewayContext("messaging___send_whatsapp"))).toMatchObject({ ok: true });
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-big", justification: "Pedido" })).toMatchObject({ ok: true, status: "PENDING" });
    expect(world.gate.sent.filter((item) => item.request.kind === "COMPLAINT_UPDATE")).toHaveLength(1);
    expect(await messaging.handle(update, gatewayContext("messaging___send_whatsapp"))).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("LAM-CONTROL, LAM-COMPLAINT-REQUIRED and LAM-SCOPE: a taken-over conversation, an answered complaint or a foreign evidence asks nothing", async () => {
    const world = await handoffWorld();
    const { complaint, turn } = await aboveCapCase(world);
    await world.takeOver();
    expect(await world.call("request_operator_approval", turn.token, { evidenceId: "rcn-big", justification: "Pedido" })).toMatchObject({ ok: false, error: { code: "CONTROL_OPERATOR" } });
    expect((await world.connector.caseItems.caseFile(WORLD, complaint.complaintId)).approvals).toEqual([]);

    const other = await handoffWorld();
    const answered = await other.addComplaint({ status: "ANSWERED" });
    await other.addEvidence({ complaintId: answered.complaintId, evidenceId: "evd-old", refId: "rcn-old", kind: "SETTLEMENT_MATCH", details: settlementMatch(ABOVE_AGENT_CAP) });
    const later = await other.openTurn({ complaintIds: [answered.complaintId] });
    expect(await other.call("request_operator_approval", later.token, { evidenceId: "rcn-old", justification: "Pedido" })).toMatchObject({ ok: false, error: { code: "COMPLAINT_REQUIRED" } });
    const empty = await other.openTurn();
    expect(await other.call("request_operator_approval", empty.token, { evidenceId: "rcn-old", justification: "Pedido" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(other.gate.sent).toEqual([]);
  });
});
