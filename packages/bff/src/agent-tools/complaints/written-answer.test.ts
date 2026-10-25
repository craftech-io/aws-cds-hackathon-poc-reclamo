import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { gatewayContext } from "../common/principal";
import { WORLD } from "../common/testing";
import { blocked, effectWorld } from "../actions/testing";
import { createComplaintsTarget } from "./handler";

const BODY = "Revisamos tu reclamo. El cargo de reposición de tarjeta no correspondía y lo revertimos con su interés compensatorio.";
const LOAN = { loanId: "L-0001", principal: 9_000_000, instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-${String(number + 7).padStart(2, "0")}-05`, amount: 3_000_000, paid: number < 3 ? 3_000_000 : 0 })) };

/** A world where the complaint was filed by the real numbering (so `FILED` exists) and then resolved. */
async function answerWorld(options: { consent?: "ACCEPTED" | "PENDING"; resolve?: boolean } = {}) {
  const world = await effectWorld([{ customerId: "cus-0001", loans: [LOAN] }]);
  const stored: { key: string; finalAnswerSeen: boolean }[] = [];
  const target = createComplaintsTarget(world.deps, {
    core: () => world.core.client,
    gate: world.gate.gate,
    complaints: world.complaintsDeps,
    documents: () => ({
      put: async (key) => {
        const entries = await world.connector.chains.listRegister("REG", WORLD, 1);
        stored.push({ key, finalAnswerSeen: entries.entries.some((entry) => entry.eventType === "FINAL_ANSWER") });
      },
    }),
  });
  await world.addInboundMessage("wamid-in-1");
  const filing = await world.openTurn();
  const registered = (await target.handle({ sessionToken: filing.token, kind: "RECLAMO", type: "UNRECOGNIZED_CHARGE", summary: "Cargo de reposición de tarjeta no pedido", sourceMessageId: "wamid-in-1" }, gatewayContext("complaints___register_complaint"))) as unknown as { complaintId: string };
  const complaintId = registered.complaintId;
  let complaint = await world.connector.complaints.get(WORLD, complaintId);
  if (complaint === undefined) throw new Error("not registered");
  if (options.consent !== "PENDING") complaint = await world.connector.complaints.patch(WORLD, complaintId, complaint.version, { emailAnswerConsent: { status: "ACCEPTED", atSim: "2026-10-07T10:00:00-03:00", textVersion: "email-answer-v1" }, subject: { loanId: "L-0001" } });
  await world.addEvidence({ complaintId, evidenceId: "evd-chk", refId: "chk-1", kind: "CHARGE_CHECK", details: { verdict: "WRONG", chargeId: "chg-card" } });
  if (options.resolve !== false) {
    const deps = world.complaintsDeps();
    const { transition } = await import("../../complaints/state-machine");
    const investigating = await transition(deps, { worldId: WORLD, complaintId, to: "INVESTIGATING", cause: "TEST", actor: "SYSTEM", atSim: "2026-10-07T10:05:00-03:00" });
    await transition(deps, { worldId: WORLD, complaintId, complaint: investigating.complaint, to: "RESOLVED", cause: "TEST", actor: "SYSTEM", atSim: "2026-10-07T10:06:00-03:00", patch: { outcome: "IN_FAVOUR" } });
  }
  world.gate.sent.length = 0;
  const turn = await world.openTurn({ complaintIds: [complaintId] });
  await world.identify();
  const answer = (input: Record<string, unknown> = {}) => target.handle({ sessionToken: turn.token, outcome: "IN_FAVOUR", draftBody: BODY, ...input }, gatewayContext("complaints___answer_complaint_in_writing"));
  return { world, complaintId, answer, stored };
}

describe("answer_complaint_in_writing", () => {
  it("claims inFlight with FINAL_ANSWER before any PDF, stores the PDFs, sends through the gate and moves to ANSWERED", async () => {
    const { world, complaintId, answer, stored } = await answerWorld();
    const result = await answer({ requestedAttachments: ["STATEMENT"] });
    expect(result).toMatchObject({ ok: true, status: "SENT", deliveryProof: "SENT", attachments: ["ANSWER", "STATEMENT"] });

    const entries = (await world.connector.chains.listRegister("REG", WORLD, 1)).entries.filter((entry) => entry.complaintId === complaintId);
    const final = entries.find((entry) => entry.eventType === "FINAL_ANSWER");
    expect(final).toMatchObject({ bodySha256: sha256Hex(BODY), reason: "IN_FAVOUR" });
    expect(stored.length).toBe(2);
    expect(stored.every((item) => item.finalAnswerSeen)).toBe(true);
    expect(stored.map((item) => item.key)).toEqual([expect.stringMatching(/^qa\/qa-tools\/complaints\/.+\/ANSWER-[0-9a-f]{16}\.pdf$/), expect.stringMatching(/\/STATEMENT-[0-9a-f]{16}\.pdf$/)]);

    expect(world.gate.sent).toHaveLength(1);
    const request = world.gate.sent[0]?.request;
    expect(request).toMatchObject({ sender: "AGENT", channel: "EMAIL", kind: "FORMAL_ANSWER", text: BODY, customerId: "cus-0001", complaintId, subject: expect.stringContaining("Respuesta escrita") });
    expect(request?.attachments?.map((file) => file.docKind)).toEqual(["ANSWER", "STATEMENT"]);
    expect(Object.keys(request ?? {})).not.toContain("to");

    const after = await world.connector.complaints.get(WORLD, complaintId);
    expect(after).toMatchObject({ status: "ANSWERED", answer: { messageId: request?.messageId, deliveryProof: "SENT" } });
    expect(after?.answer?.inFlight).toBeUndefined();
    const timers = await world.connector.timers.listByOwner(WORLD, `CMP#${complaintId}`);
    expect(timers.filter((timer) => timer.kind === "SLA").every((timer) => timer.status === "CANCELLED")).toBe(true);
    expect(timers.some((timer) => timer.kind === "AUTO_CLOSE" && timer.status === "SCHEDULED")).toBe(true);
    // Answered, the complaint is no longer open: a second answer has nothing to answer.
    expect(await answer()).toMatchObject({ ok: false, error: { code: "COMPLAINT_REQUIRED" } });
    expect(world.gate.sent).toHaveLength(1);
  });

  it("[FL-033] a reversal that issued a credit note adds the CREDIT_NOTE by code, with the refund register's figures", async () => {
    const { world, complaintId, answer, stored } = await answerWorld();
    const complaint = await world.connector.complaints.get(WORLD, complaintId);
    if (complaint === undefined) throw new Error("missing");
    const { appendChained } = await import("../../complaints/register");
    const action = { worldId: WORLD, complaintId, actionId: "act-rev-1", kind: "REVERSE_CHARGE" as const, status: "EXECUTED" as const, amountCents: 250_000, coreRef: "cn-1", idempotencyKey: "k-1", claimKey: "REV#chg-card", atSim: "2026-10-07T10:06:00-03:00", actor: "AGENT" as const };
    await appendChained(world.complaintsDeps(), {
      chain: "RRI",
      worldId: WORLD,
      epoch: 1,
      build: () => ({
        entry: { atSim: action.atSim, customerId: "cus-0001", complaintId, complaintNumber: complaint.complaintNumber, actionId: action.actionId, cause: "REVERSE_CHARGE" as const, product: "FEE-CARD-REPL", amountCents: 250_000, interestCents: 1_171, creditNoteId: "cn-1" },
        extra: [world.connector.caseItems.putActionOp(action)],
      }),
    });
    expect(await answer()).toMatchObject({ ok: true, attachments: ["ANSWER", "CREDIT_NOTE"] });
    expect(world.gate.sent[0]?.request.attachments?.map((file) => file.docKind)).toEqual(["ANSWER", "CREDIT_NOTE"]);
    expect(stored.map((item) => item.key)).toEqual([expect.stringContaining("/ANSWER-"), expect.stringContaining("/CREDIT_NOTE-")]);
  });

  it("without the customer's email consent it is NOT_ELIGIBLE and nothing is claimed, stored or sent", async () => {
    const { world, complaintId, answer, stored } = await answerWorld({ consent: "PENDING" });
    expect(await answer()).toMatchObject({ ok: false, error: { code: "NOT_ELIGIBLE", reason: "EMAIL_NOT_ACCEPTED" } });
    expect(stored).toEqual([]);
    expect(world.gate.sent).toEqual([]);
    expect((await world.connector.complaints.get(WORLD, complaintId))?.answer).toBeUndefined();
  });

  it("an unresolved complaint, a debt-free certificate of a loan with balance and an attachment outside the list are refused", async () => {
    const unresolved = await answerWorld({ resolve: false });
    expect(await unresolved.answer()).toMatchObject({ ok: false, error: { code: "NOT_ELIGIBLE", reason: "NOT_RESOLVED" } });
    const resolved = await answerWorld();
    expect(await resolved.answer({ requestedAttachments: ["PAYOFF_CERTIFICATE"] })).toMatchObject({ ok: false, error: { code: "NOT_ELIGIBLE", reason: "PAYOFF_NOT_ELIGIBLE" } });
    expect(await resolved.answer({ requestedAttachments: ["COLLECTION_NOTICE"] })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await resolved.answer({ outcome: "NOT_IN_FAVOUR" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "OUTCOME_MISMATCH" } });
    expect(resolved.world.gate.sent).toEqual([]);
  });

  it("a send the gate blocks frees the claim (the case can be answered again) and answers the gate's refusal", async () => {
    const { world, complaintId, answer } = await answerWorld();
    world.gate.answerWith(() => blocked("CH-FORMAL-CONTENT"));
    expect(await answer()).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" }, decision: "BLOCKED", ruleIds: ["CH-FORMAL-CONTENT"] });
    const after = await world.connector.complaints.get(WORLD, complaintId);
    expect(after).toMatchObject({ status: "RESOLVED" });
    expect(after?.answer?.inFlight).toBeUndefined();
  });

  it("an unknown delivery keeps the claim: never a blind resend", async () => {
    const { world, complaintId, answer } = await answerWorld();
    world.gate.answerWith(() => ({ ok: false, ruleIds: [], failure: { ok: false, error: { code: "UNKNOWN_DELIVERY", message: "maybe sent" } } }));
    expect(await answer()).toMatchObject({ ok: false, error: { code: "UNKNOWN_DELIVERY" } });
    expect((await world.connector.complaints.get(WORLD, complaintId))?.answer?.inFlight).toBeDefined();
    expect(await answer()).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "ANSWER_IN_FLIGHT" } });
  });
});
