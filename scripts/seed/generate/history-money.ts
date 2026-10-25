// Money of the historical register (docs/seed-spec.md §10): every closed charge complaint decided in
// favour of the customer reversed a wrong charge, once, with its `REV#` claim, credit note and entry
// in the chained refund register; the ones above the agent's cap went through an operator's
// approval, and one approval was rejected. Approvals and rejections are in the append-only audit log.
import { chain } from "../lib/chain";
import { EPOCH_PLACEHOLDER, WORLD_PLACEHOLDER } from "../lib/constants";
import { addMinutes, businessDaysAfter, splitLocal, utcOf } from "./calendar";
import type { HistoryComplaint, Json } from "./history";
import { type Ledger, addCharge, cents } from "./ledger";
import type { Rng } from "./rng";

/** Synthetic reference rate of the compensatory interest (an assumption, docs/seed-spec.md §3). */
export const REFERENCE_RATE = 0.38;
/** The agent's cap for a charge reversal, in centavos (docs/design-brief.md §4). */
export const REVERSE_CHARGE_AGENT_CAP = cents(15_000);

export interface MoneyHistory {
  readonly actions: Json[];
  readonly approvals: Json[];
  readonly audit: Json[];
  readonly refunds: Json[];
  readonly creditNotes: Json[];
  readonly claims: Json[];
}

export function compensatoryInterest(amount: number, chargedAt: string, creditedAt: string): number {
  const days = Math.max(0, Math.round((Date.parse(creditedAt) - Date.parse(chargedAt)) / 86_400_000));
  return Math.round((amount * REFERENCE_RATE * days) / 365);
}

function audit(action: string, atSim: string, actor: string, refs: Record<string, string>, outcome: string, index: number): Json {
  return {
    worldId: WORLD_PLACEHOLDER,
    epoch: EPOCH_PLACEHOLDER,
    auditId: `aud-h${String(index).padStart(5, "0")}`,
    ts: utcOf(atSim),
    atSim,
    action,
    actor,
    refs,
    primaryRef: `CMP#${refs.complaintId ?? ""}`,
    outcome,
    synthetic: true,
  };
}

function approval(complaint: HistoryComplaint, amount: number, decision: "APPROVED" | "REJECTED", evidenceId: string, requestedAt: string, decidedAt: string): Json {
  const expires = `${businessDaysAfter(requestedAt.slice(0, 10), 2)}T${splitLocal(requestedAt).time}:00-03:00`;
  return {
    worldId: WORLD_PLACEHOLDER,
    complaintId: complaint.complaintId,
    approvalId: `apr-${complaint.complaintId.slice(4)}`,
    action: "REVERSE_CHARGE",
    amountCents: amount,
    capTier: "OPERATOR",
    evidenceId,
    justification: "Cargo no previsto en el cuadro de tarifas para este cliente",
    requestedBy: "AGENT",
    requestedAtSim: requestedAt,
    decision,
    decidedBy: "stf-operator-01",
    decidedAtSim: decidedAt,
    ...(decision === "REJECTED" ? { reason: "El cargo corresponde a un pedido del cliente" } : { executedAt: utcOf(addMinutes(decidedAt, 1)) }),
    epoch: EPOCH_PLACEHOLDER,
    expiresAtSim: expires,
    version: 2,
    synthetic: true,
  };
}

export function buildMoneyHistory(complaints: readonly HistoryComplaint[], ledger: Ledger, rng: Rng): MoneyHistory {
  const out: MoneyHistory = { actions: [], approvals: [], audit: [], refunds: [], creditNotes: [], claims: [] };
  const refunds: Json[] = [];
  let rejected = false;
  const charges = complaints.filter((complaint) => complaint.plan.type === "UNRECOGNIZED_CHARGE" && complaint.plan.state !== "HUMAN_REVIEW" && complaint.resolvedAt);
  charges.forEach((complaint, index) => {
    const evidenceId = `evd-${complaint.complaintId.slice(4)}-1`;
    const resolvedAt = complaint.resolvedAt ?? complaint.plan.filedAt;
    if (complaint.plan.outcome !== "IN_FAVOUR") {
      if (!rejected) {
        rejected = true;
        const requestedAt = addMinutes(complaint.plan.filedAt, 20);
        out.approvals.push(approval(complaint, cents(42_000), "REJECTED", evidenceId, requestedAt, addMinutes(requestedAt, 90)));
        out.audit.push(audit("APPROVAL_DECIDED", addMinutes(requestedAt, 90), "OPERATOR:stf-operator-01", { complaintId: complaint.complaintId, approvalId: `apr-${complaint.complaintId.slice(4)}` }, "REJECTED", out.audit.length + 1));
      }
      return;
    }
    const small = index % 2 === 0;
    const amount = small ? cents(2_500) : cents(rng.int(20, 90) * 1_000);
    const chargedAt = addMinutes(complaint.plan.filedAt, -3 * 24 * 60);
    const charge = addCharge(ledger, {
      customerId: complaint.plan.customerId,
      feeCode: small ? "FEE-CARD-REPL" : "FEE-INS",
      amount,
      chargedAt,
      ...(small ? { requested: false } : {}),
      expected: small ? { verdict: "WRONG", reason: "NOT_REQUESTED", expectedAmount: 0, clauseIds: ["T-4.6"] } : { verdict: "WRONG", reason: "NOT_CHARGEABLE", expectedAmount: 0, clauseIds: ["T-1.5"] },
    });
    const actionId = `act-${complaint.complaintId.slice(4)}`;
    const creditNoteId = `cn-${complaint.complaintId.slice(4)}`;
    const interest = compensatoryInterest(amount, chargedAt, resolvedAt);
    let approvalId: string | undefined;
    if (amount > REVERSE_CHARGE_AGENT_CAP) {
      approvalId = `apr-${complaint.complaintId.slice(4)}`;
      const requestedAt = addMinutes(resolvedAt, -120);
      out.approvals.push(approval(complaint, amount, "APPROVED", evidenceId, requestedAt, addMinutes(resolvedAt, -2)));
      out.audit.push(audit("APPROVAL_DECIDED", addMinutes(resolvedAt, -2), "OPERATOR:stf-operator-01", { complaintId: complaint.complaintId, approvalId }, "APPROVED", out.audit.length + 1));
    }
    charge.reversal = { actionId, creditNoteId, complaintId: complaint.complaintId, amount, compensatoryInterest: interest, at: resolvedAt };
    out.actions.push({
      worldId: WORLD_PLACEHOLDER,
      complaintId: complaint.complaintId,
      actionId,
      kind: "REVERSE_CHARGE",
      status: "EXECUTED",
      amountCents: amount + interest,
      coreRef: creditNoteId,
      idempotencyKey: `${complaint.complaintId}:REVERSE_CHARGE:${charge.chargeId}`,
      claimKey: `REV#${charge.chargeId}`,
      evidenceId,
      ...(approvalId ? { approvalId } : {}),
      atSim: resolvedAt,
      actor: approvalId ? "SYSTEM" : "AGENT",
      synthetic: true,
    });
    out.claims.push({ claimKey: `REV#${charge.chargeId}`, kind: "REV", actionId, customerId: complaint.plan.customerId, complaintId: complaint.complaintId, amount, idempotencyKey: `${complaint.complaintId}:REVERSE_CHARGE:${charge.chargeId}` });
    out.creditNotes.push({ creditNoteId, customerId: complaint.plan.customerId, kind: "CHARGE_REVERSAL", sourceId: charge.chargeId, amount, compensatoryInterest: interest, complaintId: complaint.complaintId, actionId, creditedAtSim: resolvedAt });
    ledger.movements.push({
      movementId: `mvc-${creditNoteId.slice(3)}`,
      customerId: complaint.plan.customerId,
      kind: "CREDIT",
      at: resolvedAt,
      amount: amount + interest,
      direction: "IN",
      description: "Nota de crédito por reversión de cargo",
      status: "COMPLETED",
      ref: { chargeId: charge.chargeId, creditNoteId },
    });
    refunds.push({
      worldId: WORLD_PLACEHOLDER,
      epoch: EPOCH_PLACEHOLDER,
      atSim: resolvedAt,
      atReal: utcOf(resolvedAt),
      customerId: complaint.plan.customerId,
      complaintId: complaint.complaintId,
      complaintNumber: complaint.number,
      actionId,
      cause: "REVERSE_CHARGE",
      product: "Billetera",
      amountCents: amount,
      interestCents: interest,
      creditNoteId,
      synthetic: true,
    });
  });
  out.refunds.push(...chain(refunds.sort((a, b) => Date.parse(String(a.atSim)) - Date.parse(String(b.atSim)))));
  return out;
}
