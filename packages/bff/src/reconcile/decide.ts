// The reconciliation decision (docs/architecture-integrations.md §6.1; FL-016, FL-017, FL-018,
// FL-022, FL-026, FL-111). Pure: the published lines, the customer's applied payments and loans in;
// one of the six results out. What is compared on the customer's side always comes from the session
// (`customerId`, its loans), never from the receipt: a receipt only names the code, the amount and
// the date to look for.
//
//   MATCHED          a line with the same code, the same amount to the cent, a compatible date,
//                    `customerRef` = the session's customer and `loanRef` among his loans; not applied
//   PAYER_MISMATCH   the code is in a line of ANOTHER customer or of a loan that is not his: nothing of
//                    the other payer goes out, and a person reviews it (`RECEIPT_DOUBT`)
//   ALREADY_APPLIED  a payment with that code is applied to THIS customer (with its date)
//   PENDING_BATCH    some possible batch is still `PENDING` and no published line matches
//   NOT_FOUND        every possible batch is published and no line matches
//   AMOUNT_MISMATCH  the code is in a line of this customer with another amount
//
// "A receipt that does not exist is never found": without a matching published line nothing is
// MATCHED, whatever the receipt says.
import type { Operation, SettlementBatch, SettlementLine } from "@reclamo/core-contract";
import { addBusinessDays, nextBusinessDay } from "@reclamo/shared";
import type { ReceiptFields } from "../receipts/schema";
import { localDateAr } from "../services/business-days";

export type CollectionNetwork = "NORTE" | "SUR";

export interface AppliedPaymentRef {
  readonly network: string;
  readonly operationCode: string;
  readonly loanId: string;
  readonly appliedAtSim: string;
}

export interface CandidateBatch {
  readonly batch: SettlementBatch;
  /** The parsed file of a `PUBLISHED` batch. */
  readonly lines?: readonly SettlementLine[];
}

export interface SettlementInput {
  readonly reading: ReceiptFields & { readonly network: CollectionNetwork };
  readonly customerId: string;
  readonly loanIds: readonly string[];
  /** Payments applied to the session customer's loans. */
  readonly applied: readonly AppliedPaymentRef[];
  readonly batches: readonly CandidateBatch[];
}

export interface ReviewedBatch {
  readonly network: CollectionNetwork;
  readonly businessDate: string;
  readonly status: "PENDING" | "PUBLISHED";
  readonly sha256?: string;
}

/** The customer's own line: everything about it is his. */
export interface OwnLine {
  readonly network: CollectionNetwork;
  readonly businessDate: string;
  readonly operationCode: string;
  readonly paidAt: string;
  readonly amount: number;
  readonly customerRef: string;
  readonly loanRef: string;
  readonly instalment: number;
  readonly batchSha256: string;
}

export type SettlementDecision = { readonly reviewed: readonly ReviewedBatch[] } & (
  | { readonly result: "MATCHED"; readonly line: OwnLine }
  | { readonly result: "ALREADY_APPLIED"; readonly appliedAtSim: string; readonly loanId: string }
  | { readonly result: "AMOUNT_MISMATCH"; readonly line: OwnLine }
  | { readonly result: "PAYER_MISMATCH" }
  | { readonly result: "PENDING_BATCH"; readonly pending: { readonly network: CollectionNetwork; readonly businessDate: string; readonly publishAtSim: string } }
  | { readonly result: "NOT_FOUND" }
);

/** The business dates a payment can settle on: the receipt's date (or the next business day) and the one after. */
export function candidateBusinessDates(paidAtLocal: string, holidays: Iterable<string>): string[] {
  const list = [...holidays];
  const paidDate = paidAtLocal.slice(0, 10);
  const first = nextBusinessDay(paidDate, list);
  const second = addBusinessDays(paidDate, 1, list);
  return [...new Set([first, second])].sort();
}

function ownLine(line: SettlementLine, sha256: string): OwnLine {
  return {
    network: line.network,
    businessDate: line.businessDate,
    operationCode: line.operationCode,
    paidAt: line.paidAt,
    amount: line.amount,
    customerRef: line.customerRef,
    loanRef: line.loanRef,
    instalment: line.instalment,
    batchSha256: sha256,
  };
}

export function decideSettlement(input: SettlementInput): SettlementDecision {
  const { reading } = input;
  const reviewed: ReviewedBatch[] = input.batches.map(({ batch }) => ({ network: batch.network, businessDate: batch.businessDate, status: batch.status, ...(batch.sha256 ? { sha256: batch.sha256 } : {}) }));
  const applied = input.applied.find((payment) => payment.network === reading.network && payment.operationCode === reading.operationCode);
  if (applied !== undefined) return { result: "ALREADY_APPLIED", appliedAtSim: applied.appliedAtSim, loanId: applied.loanId, reviewed };

  const paidDate = reading.paidAtLocal.slice(0, 10);
  const loans = new Set(input.loanIds);
  const hits = input.batches.flatMap(({ batch, lines }) =>
    batch.status === "PUBLISHED" && batch.sha256 !== undefined ? (lines ?? []).filter((line) => line.network === reading.network && line.operationCode === reading.operationCode).map((line) => ({ line, sha256: batch.sha256 as string })) : [],
  );
  const own = hits.filter(({ line }) => line.customerRef === input.customerId && loans.has(line.loanRef));
  const sameDate = (line: SettlementLine) => localDateAr(new Date(line.paidAt)) === paidDate;
  const matched = own.find(({ line }) => line.amount === reading.amount && sameDate(line));
  if (matched) return { result: "MATCHED", line: ownLine(matched.line, matched.sha256), reviewed };
  // The code is someone else's: the receipt of another person, or a code taken from a batch.
  if (hits.some(({ line }) => !(line.customerRef === input.customerId && loans.has(line.loanRef)))) return { result: "PAYER_MISMATCH", reviewed };
  const otherAmount = own.find(({ line }) => line.amount !== reading.amount);
  if (otherAmount) return { result: "AMOUNT_MISMATCH", line: ownLine(otherAmount.line, otherAmount.sha256), reviewed };

  const pending = input.batches
    .map(({ batch }) => batch)
    .filter((batch) => batch.status === "PENDING")
    .sort((a, b) => (a.publishAtSim < b.publishAtSim ? -1 : a.publishAtSim > b.publishAtSim ? 1 : 0))[0];
  if (pending) return { result: "PENDING_BATCH", pending: { network: pending.network, businessDate: pending.businessDate, publishAtSim: pending.publishAtSim }, reviewed };
  return { result: "NOT_FOUND", reviewed };
}

// ---- Wallet and transfer payments (FL-026) ------------------------------------------------------------

export type MovementSource = "WALLET" | "TRANSFER";

const MOVEMENT_KINDS: Readonly<Record<MovementSource, ReadonlySet<Operation["kind"]>>> = {
  WALLET: new Set(["PAYMENT", "DEBIT"]),
  TRANSFER: new Set(["TRANSFER_OUT", "PAYMENT"]),
};

export interface MovementInput {
  readonly source: MovementSource;
  readonly movementId: string;
  /** The session customer's operations (the core lists only his). */
  readonly operations: readonly Operation[];
  readonly loanIds: readonly string[];
  /** Payments applied to the session customer's loans. */
  readonly applied: readonly AppliedPaymentRef[];
  /** The code and amount of a READ receipt reading, when there is one. */
  readonly reading?: { readonly operationCode: string; readonly amount: number };
}

export type MovementDecision =
  | { readonly result: "MATCHED"; readonly movement: { readonly operationId: string; readonly amount: number; readonly atSim: string; readonly loanId: string; readonly instalment?: number } }
  | { readonly result: "ALREADY_APPLIED"; readonly appliedAtSim: string; readonly loanId: string }
  | { readonly result: "AMOUNT_MISMATCH"; readonly movement: { readonly operationId: string; readonly amount: number } }
  | { readonly result: "NOT_FOUND" };

export function decideMovement(input: MovementInput): MovementDecision {
  const operation = input.operations.find((candidate) => candidate.operationId === input.movementId);
  const loanId = operation?.ref.loanId;
  if (operation === undefined || loanId === undefined || !input.loanIds.includes(loanId)) return { result: "NOT_FOUND" };
  if (!MOVEMENT_KINDS[input.source].has(operation.kind) || operation.direction !== "OUT" || operation.status !== "COMPLETED") return { result: "NOT_FOUND" };
  if (operation.ref.paymentId !== undefined) return { result: "ALREADY_APPLIED", appliedAtSim: operation.atSim, loanId };
  const applied = input.reading && input.applied.find((payment) => payment.network === input.source && payment.operationCode === input.reading?.operationCode);
  if (applied) return { result: "ALREADY_APPLIED", appliedAtSim: applied.appliedAtSim, loanId: applied.loanId };
  if (input.reading !== undefined && input.reading.amount !== operation.amount) return { result: "AMOUNT_MISMATCH", movement: { operationId: operation.operationId, amount: operation.amount } };
  return {
    result: "MATCHED",
    movement: { operationId: operation.operationId, amount: operation.amount, atSim: operation.atSim, loanId, ...(operation.ref.instalment === undefined ? {} : { instalment: operation.ref.instalment }) },
  };
}
