// Loan side of the lender core (docs/architecture-integrations.md §5): loans, instalments, the
// payment imputation, charges and their reversal, duplicate debits and their refund, the early
// payoff quote and the disbursement. Every money route carries the session's `customerId`, an
// `idempotencyKey` and the `cap` of the caller; the core takes the natural-key claim (`OPC#`,
// `REV#`, `RFD#`) in the transaction that moves the money and answers `CONFLICT` with the existing
// `actionId` to a second attempt.
import { z } from "zod";
import { CalendarDate, Cents, CustomerId, IdempotencyKey, InstalmentNumber, LoanId, OperationCode, PositiveCents, ResourceId, SimInstant } from "./common";
import { LoanStatus } from "./core-accounts";
import { core } from "./registry";

export const PaymentNetwork = core("PaymentNetwork", z.enum(["NORTE", "SUR", "TRANSFER", "WALLET"]));
export type PaymentNetwork = z.infer<typeof PaymentNetwork>;

export const InstalmentStatus = core("InstalmentStatus", z.enum(["DUE", "PAID", "PARTIALLY_PAID", "OVERDUE"]));
export type InstalmentStatus = z.infer<typeof InstalmentStatus>;

export const ClauseId = core("ClauseId", z.string().regex(/^(T-\d+\.\d+|D-\d+|P-\d+)$/));
export type ClauseId = z.infer<typeof ClauseId>;

export const FeeCode = core("FeeCode", z.string().regex(/^FEE-[A-Z]+(-[A-Z]+)*$/));
export type FeeCode = z.infer<typeof FeeCode>;

export const NextDue = core("NextDue", z.object({ number: InstalmentNumber, dueDate: CalendarDate, amount: Cents }).strict());
export type NextDue = z.infer<typeof NextDue>;

export const Loan = core(
  "Loan",
  z
    .object({
      loanId: LoanId,
      customerId: CustomerId,
      label: z.string().min(1).max(80),
      principal: PositiveCents,
      instalmentsCount: z.number().int().min(3).max(18),
      paidCount: z.number().int().min(0).max(18),
      annualRate: z.number().min(0).max(10),
      status: LoanStatus,
      outstanding: Cents,
      disbursedAtSim: SimInstant.optional(),
      cancelledAtSim: SimInstant.optional(),
      nextDue: NextDue.optional(),
    })
    .strict(),
);
export type Loan = z.infer<typeof Loan>;

export const AppliedPayment = core(
  "AppliedPayment",
  z
    .object({
      paymentId: ResourceId,
      network: PaymentNetwork,
      operationCode: OperationCode,
      amount: PositiveCents,
      paidAtSim: SimInstant,
      appliedAtSim: SimInstant,
    })
    .strict(),
);
export type AppliedPayment = z.infer<typeof AppliedPayment>;

export const Instalment = core(
  "Instalment",
  z
    .object({
      number: InstalmentNumber,
      dueDate: CalendarDate,
      principal: Cents,
      interest: Cents,
      vat: Cents,
      amount: Cents,
      lateInterest: Cents,
      outstanding: Cents,
      status: InstalmentStatus,
      payments: z.array(AppliedPayment).max(20),
    })
    .strict(),
);
export type Instalment = z.infer<typeof Instalment>;

export const InstalmentList = core(
  "InstalmentList",
  z.object({ loanId: LoanId, customerId: CustomerId, instalments: z.array(Instalment).min(3).max(18) }).strict(),
);
export type InstalmentList = z.infer<typeof InstalmentList>;

export const PaymentSource = core("PaymentSource", z.enum(["SETTLEMENT", "WALLET", "TRANSFER"]));
export type PaymentSource = z.infer<typeof PaymentSource>;

export const PaymentRequest = core(
  "PaymentRequest",
  z
    .object({
      customerId: CustomerId,
      complaintId: ResourceId,
      reconciliationId: ResourceId,
      network: PaymentNetwork,
      operationCode: OperationCode,
      amount: PositiveCents,
      paidAtSim: SimInstant,
      source: PaymentSource,
      idempotencyKey: IdempotencyKey,
      cap: Cents,
    })
    .strict(),
);
export type PaymentRequest = z.infer<typeof PaymentRequest>;

export const Allocation = core(
  "Allocation",
  z.object({ instalment: InstalmentNumber, amount: PositiveCents, statusAfter: InstalmentStatus }).strict(),
);
export type Allocation = z.infer<typeof Allocation>;

export const PaymentResult = core(
  "PaymentResult",
  z
    .object({
      actionId: ResourceId,
      paymentId: ResourceId,
      applied: PositiveCents,
      lateInterest: Cents,
      allocations: z.array(Allocation).min(1).max(18),
      loanStatusAfter: LoanStatus,
      outstandingAfter: Cents,
    })
    .strict(),
);
export type PaymentResult = z.infer<typeof PaymentResult>;

export const ChargeVerdict = core("ChargeVerdict", z.enum(["CORRECT", "WRONG", "UNDETERMINED"]));
export type ChargeVerdict = z.infer<typeof ChargeVerdict>;

export const ChargeCheckReason = core(
  "ChargeCheckReason",
  z.enum(["MATCHES_SCHEDULE", "NOT_REQUESTED", "NOT_CHARGEABLE", "DUPLICATED", "AMOUNT_DIFFERS", "WITHIN_TOLERANCE", "NO_RULE"]),
);
export type ChargeCheckReason = z.infer<typeof ChargeCheckReason>;

/** The reversal a charge already had (claim `REV#<chargeId>` taken): what the customer got back and when. */
export const AppliedChargeReversal = core(
  "AppliedChargeReversal",
  z
    .object({
      actionId: ResourceId,
      complaintId: ResourceId,
      creditNoteId: ResourceId,
      amount: PositiveCents,
      compensatoryInterest: Cents,
      creditedAtSim: SimInstant,
    })
    .strict(),
);
export type AppliedChargeReversal = z.infer<typeof AppliedChargeReversal>;

export const ChargeCheck = core(
  "ChargeCheck",
  z
    .object({
      chargeId: ResourceId,
      customerId: CustomerId,
      loanId: LoanId.optional(),
      feeCode: FeeCode,
      charged: PositiveCents,
      chargedAtSim: SimInstant,
      verdict: ChargeVerdict,
      expectedAmount: Cents,
      clauseIds: z.array(ClauseId).max(8),
      reason: ChargeCheckReason,
      scheduleVersion: z.string().regex(/^v\d{3}$/),
      reversal: AppliedChargeReversal.optional(),
    })
    .strict(),
);
export type ChargeCheck = z.infer<typeof ChargeCheck>;

export const ChargeReversalRequest = core(
  "ChargeReversalRequest",
  z
    .object({
      customerId: CustomerId,
      complaintId: ResourceId,
      idempotencyKey: IdempotencyKey,
      cap: Cents,
      referenceRate: z.number().positive().max(5),
    })
    .strict(),
);
export type ChargeReversalRequest = z.infer<typeof ChargeReversalRequest>;

export const ChargeReversalResult = core(
  "ChargeReversalResult",
  z
    .object({
      actionId: ResourceId,
      chargeId: ResourceId,
      creditNoteId: ResourceId,
      amount: PositiveCents,
      compensatoryInterest: Cents,
      days: z.number().int().min(0).max(3650),
      referenceRate: z.number().positive().max(5),
      creditedAtSim: SimInstant,
    })
    .strict(),
);
export type ChargeReversalResult = z.infer<typeof ChargeReversalResult>;

export const DuplicateCheckRequest = core("DuplicateCheckRequest", z.object({ instalment: InstalmentNumber.optional() }).strict());
export type DuplicateCheckRequest = z.infer<typeof DuplicateCheckRequest>;

export const Debit = core(
  "Debit",
  z.object({ debitId: ResourceId, instalment: InstalmentNumber, amount: PositiveCents, atSim: SimInstant }).strict(),
);
export type Debit = z.infer<typeof Debit>;

export const DuplicateCheck = core(
  "DuplicateCheck",
  z
    .object({
      loanId: LoanId,
      customerId: CustomerId,
      verdict: z.enum(["DUPLICATE", "NOT_DUPLICATE"]),
      debits: z.array(Debit).max(10),
      duplicateDebitId: ResourceId.optional(),
      refundable: Cents,
    })
    .strict(),
);
export type DuplicateCheck = z.infer<typeof DuplicateCheck>;

export const RefundRequest = core(
  "RefundRequest",
  z
    .object({ customerId: CustomerId, complaintId: ResourceId, debitId: ResourceId, idempotencyKey: IdempotencyKey, cap: Cents })
    .strict(),
);
export type RefundRequest = z.infer<typeof RefundRequest>;

export const RefundResult = core(
  "RefundResult",
  z
    .object({ actionId: ResourceId, debitId: ResourceId, creditNoteId: ResourceId, amount: PositiveCents, creditedAtSim: SimInstant })
    .strict(),
);
export type RefundResult = z.infer<typeof RefundResult>;

export const PayoffQuoteRequest = core("PayoffQuoteRequest", z.object({ customerId: CustomerId }).strict());
export type PayoffQuoteRequest = z.infer<typeof PayoffQuoteRequest>;

export const PayoffQuote = core(
  "PayoffQuote",
  z
    .object({
      quoteId: ResourceId,
      loanId: LoanId,
      customerId: CustomerId,
      principal: Cents,
      accruedInterest: Cents,
      fee: Cents,
      feeClauseId: ClauseId.optional(),
      total: Cents,
      asOfSim: SimInstant,
      validUntilSim: SimInstant,
    })
    .strict(),
);
export type PayoffQuote = z.infer<typeof PayoffQuote>;

export const DisbursementStatus = core("DisbursementStatus", z.enum(["PENDING", "CREDITED", "FAILED_RETURNED", "HELD_REVIEW"]));
export type DisbursementStatus = z.infer<typeof DisbursementStatus>;

export const Disbursement = core(
  "Disbursement",
  z
    .object({
      loanId: LoanId,
      customerId: CustomerId,
      status: DisbursementStatus,
      gross: PositiveCents,
      originationFee: Cents,
      net: Cents,
      creditedAtSim: SimInstant.optional(),
      expectedBySim: SimInstant.optional(),
      returnedAtSim: SimInstant.optional(),
    })
    .strict(),
);
export type Disbursement = z.infer<typeof Disbursement>;
