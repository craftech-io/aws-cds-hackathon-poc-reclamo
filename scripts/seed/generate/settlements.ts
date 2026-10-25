// Settlement batches of the two collection networks (docs/seed-spec.md §7): the business date of
// every network payment by cut-off, the batches of the 30 business days before the world starts
// (published, with their CSV) and the two batches still pending at the start (`NORTE 2026-10-07` with
// the main story's payment, `SUR 2026-10-06`). A published payment of another payer is applied when
// its batch is published; a pending one is not.
import { type SettlementLine, formatSettlementCsv } from "@reclamo/core-contract";
import { START_AT_SIM, START_DATE } from "../lib/constants";
import { sha256Hex } from "../lib/json";
import { type CollectionNetwork, addMinutes, businessDateOf, businessDaysBefore, compareInstants, publishInstant } from "./calendar";
import type { Ledger, PaymentRecord } from "./ledger";

export const SETTLEMENT_WINDOW_DAYS = 30;

/** The pending batches at the start (and no other: invariant 15 and the guided tour depend on it). */
export const PENDING_BATCHES: ReadonlyArray<{ readonly network: CollectionNetwork; readonly businessDate: string }> = [
  { network: "NORTE", businessDate: "2026-10-07" },
  { network: "SUR", businessDate: "2026-10-06" },
];

export interface Batch {
  readonly network: CollectionNetwork;
  readonly businessDate: string;
  readonly status: "PUBLISHED" | "PENDING";
  readonly publishAt: string;
  readonly lines: SettlementLine[];
  csv?: string;
  sha256?: string;
}

/** Business dates of the window: the 30 business days before the start. */
export function windowDates(): string[] {
  return businessDaysBefore(START_DATE, SETTLEMENT_WINDOW_DAYS);
}

/** Every batch the template holds, oldest first: published ones whose publication is before the start, plus the pending ones. */
export function batchSlots(): Array<Pick<Batch, "network" | "businessDate" | "status" | "publishAt">> {
  const slots: Array<Pick<Batch, "network" | "businessDate" | "status" | "publishAt">> = [];
  for (const businessDate of windowDates()) {
    for (const network of ["NORTE", "SUR"] as const) {
      const publishAt = publishInstant(network, businessDate);
      const pending = PENDING_BATCHES.some((batch) => batch.network === network && batch.businessDate === businessDate);
      if (pending) slots.push({ network, businessDate, status: "PENDING", publishAt });
      else if (compareInstants(publishAt, START_AT_SIM) < 0) slots.push({ network, businessDate, status: "PUBLISHED", publishAt });
    }
  }
  for (const pending of PENDING_BATCHES) {
    if (!slots.some((slot) => slot.network === pending.network && slot.businessDate === pending.businessDate)) {
      slots.push({ ...pending, status: "PENDING", publishAt: publishInstant(pending.network, pending.businessDate) });
    }
  }
  return slots.sort((a, b) => compareInstants(a.publishAt, b.publishAt));
}

function lineOf(payment: PaymentRecord, businessDate: string): SettlementLine {
  return {
    network: payment.network as CollectionNetwork,
    businessDate,
    operationCode: payment.operationCode,
    paidAt: payment.paidAt,
    amount: payment.amount,
    customerRef: payment.customerId,
    loanRef: payment.loanId,
    instalment: payment.instalments[0] ?? 1,
    terminal: payment.terminal ?? "T-0001",
  };
}

/**
 * Puts every network payment of the ledger in its batch; applies the other payers' payments of a
 * published batch at its publication (the personas keep the flag their scenario sets).
 */
export function assembleBatches(ledger: Ledger, personaCustomers: ReadonlySet<string>): Batch[] {
  const slots = batchSlots();
  const batches = slots.map((slot): Batch => ({ ...slot, lines: [] }));
  for (const payment of ledger.payments) {
    if (payment.network === "WALLET") continue;
    const businessDate = businessDateOf(payment.network, payment.paidAt);
    const batch = batches.find((candidate) => candidate.network === payment.network && candidate.businessDate === businessDate);
    if (!batch) throw new Error(`payment ${payment.paymentId} (${payment.network} ${businessDate}) has no batch in the template`);
    payment.businessDate = businessDate;
    batch.lines.push(lineOf(payment, businessDate));
    if (batch.status === "PUBLISHED" && (payment.applied || !personaCustomers.has(payment.customerId))) {
      if (!payment.applied) throw new Error(`payer payment ${payment.paymentId} must be created applied`);
      payment.appliedAt = addMinutes(batch.publishAt, 5);
    }
    if (batch.status === "PENDING" && payment.applied) throw new Error(`payment ${payment.paymentId} is applied but its batch is pending`);
  }
  for (const batch of batches) {
    batch.lines.sort((a, b) => compareInstants(a.paidAt, b.paidAt) || (a.operationCode < b.operationCode ? -1 : 1));
    if (batch.status === "PUBLISHED") {
      batch.csv = formatSettlementCsv(batch.lines);
      batch.sha256 = sha256Hex(batch.csv);
    }
  }
  return batches;
}

/** The batches of a template that holds only `customerIds`: the same batches, its own lines and CSV. */
export function batchesFor(batches: readonly Batch[], customerIds: ReadonlySet<string>): Batch[] {
  return batches.map((batch) => {
    const lines = batch.lines.filter((line) => customerIds.has(line.customerRef));
    const own: Batch = { network: batch.network, businessDate: batch.businessDate, status: batch.status, publishAt: batch.publishAt, lines };
    if (batch.status === "PUBLISHED") {
      own.csv = formatSettlementCsv(lines);
      own.sha256 = sha256Hex(own.csv);
    }
    return own;
  });
}

/** Path of a published batch's CSV under `data/settlements/<template>/`. */
export function batchPath(network: CollectionNetwork, businessDate: string): string {
  return `${network}/${businessDate}/batch-1.csv`;
}
