// `LAM-EVIDENCE` (docs/design-brief.md §8.6): what each action needs from the investigation of its
// complaint, read from the evidence the investigation tools left (`Evidence.details`, written by
// reconcile/ and agent-tools/investigation/). The details are data of this system, but they are parsed
// with zod like any other edge: an evidence of the wrong kind, a reconciliation that is not `MATCHED`, a
// check that is not `WRONG` or `DUPLICATE`, a transfer that is not `REJECTED_NOT_REVERSED`, or details
// that do not say what the action needs → `EVIDENCE_REQUIRED`, and nothing moves. Extra fields are
// allowed (each investigation tool keeps what it needs); the fields below are the contract.
import { z } from "zod";
import { CustomerId, InstalmentNumber, LoanId, OperationCode, PaymentNetwork, PositiveCents, ResourceId, SimInstant } from "@reclamo/core-contract";
import { type CapAction, ToolError } from "@reclamo/shared";
import type { Evidence, EvidenceKind } from "../../domain/case-items";

/** `SETTLEMENT_MATCH` `MATCHED` against a network's settlement: the published line (reconcile/decide.ts). */
const SettlementMatch = z.looseObject({
  result: z.literal("MATCHED"),
  source: z.literal("SETTLEMENT").default("SETTLEMENT"),
  line: z.looseObject({
    network: PaymentNetwork,
    operationCode: OperationCode,
    amount: PositiveCents,
    paidAt: SimInstant,
    customerRef: CustomerId,
    loanRef: LoanId,
    instalment: InstalmentNumber.optional(),
  }),
});

/** `SETTLEMENT_MATCH` `MATCHED` against a wallet or transfer movement the core listed for the customer. */
const MovementMatch = z.looseObject({
  result: z.literal("MATCHED"),
  source: z.enum(["WALLET", "TRANSFER"]),
  operationCode: OperationCode.optional(),
  movement: z.looseObject({ operationId: OperationCode, amount: PositiveCents, atSim: SimInstant, loanId: LoanId, instalment: InstalmentNumber.optional() }),
});

export const MatchedPaymentDetails = z.union([SettlementMatch, MovementMatch]);
export type MatchedPaymentDetails = z.infer<typeof MatchedPaymentDetails>;

/** The payment a matched reconciliation proves, whatever its source. */
export interface MatchedPayment {
  readonly source: "SETTLEMENT" | "WALLET" | "TRANSFER";
  readonly network: z.infer<typeof PaymentNetwork>;
  readonly operationCode: string;
  readonly amount: number;
  readonly paidAt: string;
  readonly loanId: string;
  /** The payer of a settlement line; a movement is the customer's by the core's own listing. */
  readonly customerRef?: string;
}

export function matchedPaymentOf(details: MatchedPaymentDetails): MatchedPayment {
  if (details.source === "SETTLEMENT") {
    const { line } = details;
    return { source: "SETTLEMENT", network: line.network, operationCode: line.operationCode, amount: line.amount, paidAt: line.paidAt, loanId: line.loanRef, customerRef: line.customerRef };
  }
  const { movement } = details;
  return { source: details.source, network: details.source, operationCode: details.operationCode ?? movement.operationId, amount: movement.amount, paidAt: movement.atSim, loanId: movement.loanId };
}

/** `CHARGE_CHECK` with `verdict WRONG`: the charge; the core recomputes it before reversing. */
export const WrongChargeDetails = z.looseObject({ verdict: z.literal("WRONG"), chargeId: ResourceId });
export type WrongChargeDetails = z.infer<typeof WrongChargeDetails>;

/** `DUPLICATE_CHECK` with `verdict DUPLICATE`: the loan (and instalment) the core checks again. */
export const DuplicateDebitDetails = z.looseObject({
  verdict: z.literal("DUPLICATE"),
  loanId: LoanId,
  instalment: InstalmentNumber.optional(),
  duplicateDebitId: ResourceId.optional(),
});
export type DuplicateDebitDetails = z.infer<typeof DuplicateDebitDetails>;

/** `TRANSFER_STATUS` with `status REJECTED_NOT_REVERSED`: the transfer and the amount the core listed. */
export const RejectedTransferDetails = z.looseObject({
  status: z.literal("REJECTED_NOT_REVERSED"),
  transferId: ResourceId,
  amount: PositiveCents,
});
export type RejectedTransferDetails = z.infer<typeof RejectedTransferDetails>;

/** Source of the marker an `ABOVE_CAP` leaves (`IDEMP#ABOVE_CAP#<evidenceId>`), read by `request_operator_approval`. */
export const ABOVE_CAP_MARKER = "ABOVE_CAP";

/** The evidence each money action needs, and what its details must say. */
export const MONEY_EVIDENCE = {
  APPLY_PAYMENT: { kind: "SETTLEMENT_MATCH", details: MatchedPaymentDetails },
  REVERSE_CHARGE: { kind: "CHARGE_CHECK", details: WrongChargeDetails },
  REFUND_DUPLICATE: { kind: "DUPLICATE_CHECK", details: DuplicateDebitDetails },
  TRANSFER_REVERSAL: { kind: "TRANSFER_STATUS", details: RejectedTransferDetails },
} as const satisfies Readonly<Record<CapAction, { readonly kind: EvidenceKind; readonly details: z.ZodType }>>;

export type MoneyDetails<A extends CapAction> = z.infer<(typeof MONEY_EVIDENCE)[A]["details"]>;

/** The money action an evidence can found, by its kind (`request_operator_approval` reads it). */
export function capActionOfEvidence(evidence: Pick<Evidence, "kind">): CapAction | undefined {
  return (Object.keys(MONEY_EVIDENCE) as CapAction[]).find((action) => MONEY_EVIDENCE[action].kind === evidence.kind);
}

/** The details of `evidence` as `action` needs them, or `EVIDENCE_REQUIRED`. */
export function moneyDetails<A extends CapAction>(action: A, evidence: Evidence): MoneyDetails<A> {
  const rule = MONEY_EVIDENCE[action];
  if (evidence.kind !== rule.kind) throw new ToolError("EVIDENCE_REQUIRED", `${action} needs a ${rule.kind} evidence of this complaint`, "EVIDENCE_KIND");
  const parsed = rule.details.safeParse(evidence.details);
  if (!parsed.success) throw new ToolError("EVIDENCE_REQUIRED", `the ${rule.kind} evidence does not allow ${action}`, "EVIDENCE_RESULT");
  return parsed.data as MoneyDetails<A>;
}

/** The one evidence the scope check found for the input's id (`LAM-SCOPE` already proved it is the complaint's). */
export function scopedEvidence(findings: { readonly evidence: readonly Evidence[] }, id: string): Evidence {
  const found = findings.evidence.find((item) => item.evidenceId === id || item.refId === id);
  if (found === undefined) throw new ToolError("EVIDENCE_REQUIRED", "the evidence is not one of this complaint", "EVIDENCE_MISSING");
  return found;
}
