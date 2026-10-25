// Customer side of the lender core (docs/architecture-integrations.md §5): identity, account,
// wallet, the identity challenge, operations, the outgoing freeze and the closure and data-change
// requests. Personal data leaves the core masked; the live phone number and the expected challenge
// answer have no field in the customer's file, so a strict parse drops nothing silently: it fails. The
// live number leaves the core only through `LiveRecipient`, a route of its own that only the
// functions running the outbound gate may call, and only for a world that may run live.
import { z } from "zod";
import { CalendarDate, Cents, CustomerId, IdempotencyKey, InstalmentNumber, LoanId, PositiveCents, ResourceId, SimInstant } from "./common";
import { core } from "./registry";

export const PhoneHash = core("PhoneHash", z.string().regex(/^[0-9a-f]{64}$/));
export type PhoneHash = z.infer<typeof PhoneHash>;

export const CustomerRef = core("CustomerRef", z.object({ customerId: CustomerId }).strict());
export type CustomerRef = z.infer<typeof CustomerRef>;

/** The live WhatsApp number of a customer (E.164), present only in a world that may run live and only when the seed set one. */
export const LiveRecipient = core("LiveRecipient", z.object({ customerId: CustomerId, e164: z.string().regex(/^\+\d{8,15}$/).optional() }).strict());
export type LiveRecipient = z.infer<typeof LiveRecipient>;

export const AccountStatus = core("AccountStatus", z.enum(["ACTIVE", "BLOCKED", "CLOSING", "CLOSED"]));
export type AccountStatus = z.infer<typeof AccountStatus>;

export const BlockCategory = core("BlockCategory", z.enum(["SECURITY_REVIEW", "IDENTITY_VALIDATION", "EXTERNAL_ORDER", "INACTIVITY"]));
export type BlockCategory = z.infer<typeof BlockCategory>;

export const LoanStatus = core("LoanStatus", z.enum(["ACTIVE", "IN_ARREARS", "CANCELLED", "EARLY_CANCELLED"]));
export type LoanStatus = z.infer<typeof LoanStatus>;

export const PresenterDocument = core(
  "PresenterDocument",
  z.object({ type: z.enum(["DNI"]), numberMasked: z.string().regex(/^•{4}\d{4}$/) }).strict(),
);
export type PresenterDocument = z.infer<typeof PresenterDocument>;

export const WhatsAppConsent = core(
  "WhatsAppConsent",
  z
    .object({
      optedIn: z.boolean(),
      optedInAtSim: SimInstant.optional(),
      optInMedium: z.enum(["SIGNED_ONBOARDING", "IN_CHAT"]).optional(),
      optInTextVersion: z.string().regex(/^v\d{3}$/).optional(),
      optedOut: z.boolean(),
      optedOutAtSim: SimInstant.optional(),
    })
    .strict(),
);
export type WhatsAppConsent = z.infer<typeof WhatsAppConsent>;

export const Account = core(
  "Account",
  z.object({ status: AccountStatus, blockCategory: BlockCategory.optional(), closureRequestedAtSim: SimInstant.optional() }).strict(),
);
export type Account = z.infer<typeof Account>;

export const Wallet = core(
  "Wallet",
  z
    .object({
      balance: Cents,
      cvuMasked: z.string().regex(/^•{4} \d{4}$/),
      outgoingFrozen: z.boolean(),
      frozenAtSim: SimInstant.optional(),
    })
    .strict(),
);
export type Wallet = z.infer<typeof Wallet>;

export const LoanSummary = core(
  "LoanSummary",
  z.object({ loanId: LoanId, label: z.string().min(1).max(80), status: LoanStatus, outstanding: Cents }).strict(),
);
export type LoanSummary = z.infer<typeof LoanSummary>;

export const Customer = core(
  "Customer",
  z
    .object({
      customerId: CustomerId,
      firstName: z.string().min(1).max(60),
      lastName: z.string().min(1).max(60),
      document: PresenterDocument,
      phoneMasked: z.string().min(1).max(32),
      emailMasked: z.string().min(1).max(120),
      whatsapp: WhatsAppConsent,
      account: Account,
      wallet: Wallet,
      loans: z.array(LoanSummary).max(10),
    })
    .strict(),
);
export type Customer = z.infer<typeof Customer>;

export const ChallengeKind = core("ChallengeKind", z.enum(["LAST_DUE_DATE", "LAST_INSTALMENT_AMOUNT", "LAST_MOVEMENT_AMOUNT"]));
export type ChallengeKind = z.infer<typeof ChallengeKind>;

export const ChallengeCheckRequest = core(
  "ChallengeCheckRequest",
  z.object({ kind: ChallengeKind, answer: z.string().min(1).max(40) }).strict(),
);
export type ChallengeCheckRequest = z.infer<typeof ChallengeCheckRequest>;

/** Only whether the answer matched: the expected value never leaves the core. */
export const ChallengeCheckResult = core("ChallengeCheckResult", z.object({ ok: z.boolean() }).strict());
export type ChallengeCheckResult = z.infer<typeof ChallengeCheckResult>;

export const OperationKind = core(
  "OperationKind",
  z.enum(["PAYMENT", "CHARGE", "TRANSFER_IN", "TRANSFER_OUT", "DISBURSEMENT", "DEBIT", "CREDIT"]),
);
export type OperationKind = z.infer<typeof OperationKind>;

export const OperationKindFilter = core(
  "OperationKindFilter",
  z.enum(["PAYMENT", "CHARGE", "TRANSFER_IN", "TRANSFER_OUT", "DISBURSEMENT", "DEBIT", "CREDIT", "ALL"]),
);
export type OperationKindFilter = z.infer<typeof OperationKindFilter>;

export const OperationStatus = core("OperationStatus", z.enum(["COMPLETED", "PENDING", "REJECTED", "REVERSED"]));
export type OperationStatus = z.infer<typeof OperationStatus>;

export const OperationRef = core(
  "OperationRef",
  z
    .object({
      loanId: LoanId.optional(),
      instalment: InstalmentNumber.optional(),
      chargeId: ResourceId.optional(),
      debitId: ResourceId.optional(),
      transferId: ResourceId.optional(),
      paymentId: ResourceId.optional(),
      creditNoteId: ResourceId.optional(),
    })
    .strict(),
);
export type OperationRef = z.infer<typeof OperationRef>;

/** `description` is free text of the core: the tools return it escaped, as data. */
export const Operation = core(
  "Operation",
  z
    .object({
      operationId: ResourceId,
      kind: OperationKind,
      atSim: SimInstant,
      amount: Cents,
      direction: z.enum(["IN", "OUT"]),
      description: z.string().min(1).max(140),
      status: OperationStatus,
      ref: OperationRef,
    })
    .strict(),
);
export type Operation = z.infer<typeof Operation>;

export const OperationsQuery = z.object({ from: CalendarDate, to: CalendarDate, kind: OperationKindFilter.optional() }).strict();
export type OperationsQuery = z.infer<typeof OperationsQuery>;

export const OperationList = core(
  "OperationList",
  z
    .object({
      customerId: CustomerId,
      from: CalendarDate,
      to: CalendarDate,
      operations: z.array(Operation).max(100),
      truncated: z.boolean(),
    })
    .strict(),
);
export type OperationList = z.infer<typeof OperationList>;

export const FreezeRequest = core(
  "FreezeRequest",
  z
    .object({
      active: z.boolean(),
      reason: z.enum(["UNKNOWN_OPERATION", "CUSTOMER_REQUEST", "STAFF_DECISION"]),
      by: z.enum(["AGENT", "STAFF", "SYSTEM"]),
      complaintId: ResourceId.optional(),
      idempotencyKey: IdempotencyKey,
    })
    .strict(),
);
export type FreezeRequest = z.infer<typeof FreezeRequest>;

export const FreezeResult = core(
  "FreezeResult",
  z.object({ actionId: ResourceId, outgoingFrozen: z.boolean(), changed: z.boolean(), atSim: SimInstant }).strict(),
);
export type FreezeResult = z.infer<typeof FreezeResult>;

/**
 * The wallet credit of an outgoing transfer the network reversed (FL-044): the core finds the
 * transfer among the customer's, credits its own amount and takes the claim `TRV#<transferId>` in the
 * same transaction, so a transfer is credited back once whatever the number of complaints.
 */
export const TransferReversalCreditRequest = core(
  "TransferReversalCreditRequest",
  z.object({ complaintId: ResourceId, transferId: ResourceId, idempotencyKey: IdempotencyKey }).strict(),
);
export type TransferReversalCreditRequest = z.infer<typeof TransferReversalCreditRequest>;

export const TransferReversalCreditResult = core(
  "TransferReversalCreditResult",
  z.object({ actionId: ResourceId, transferId: ResourceId, amount: PositiveCents, creditedAtSim: SimInstant }).strict(),
);
export type TransferReversalCreditResult = z.infer<typeof TransferReversalCreditResult>;

/** The customer's WhatsApp opt-out ("baja" by keyword or button, FL-006): only the customer opts out. */
export const WhatsAppOptOutRequest = core(
  "WhatsAppOptOutRequest",
  z.object({ via: z.enum(["KEYWORD", "BUTTON"]), idempotencyKey: IdempotencyKey }).strict(),
);
export type WhatsAppOptOutRequest = z.infer<typeof WhatsAppOptOutRequest>;

export const WhatsAppOptOutResult = core(
  "WhatsAppOptOutResult",
  z.object({ optedOut: z.literal(true), changed: z.boolean(), optedOutAtSim: SimInstant }).strict(),
);
export type WhatsAppOptOutResult = z.infer<typeof WhatsAppOptOutResult>;

export const ClosureRequest = core("ClosureRequest", z.object({ complaintId: ResourceId, idempotencyKey: IdempotencyKey }).strict());
export type ClosureRequest = z.infer<typeof ClosureRequest>;

export const ClosureCondition = core(
  "ClosureCondition",
  z
    .object({
      code: z.enum(["ACTIVE_LOAN", "WALLET_BALANCE", "PENDING_TRANSFER"]),
      loanId: LoanId.optional(),
      amount: Cents.optional(),
    })
    .strict(),
);
export type ClosureCondition = z.infer<typeof ClosureCondition>;

export const ClosureResult = core(
  "ClosureResult",
  z
    .object({
      actionId: ResourceId,
      accountStatusAfter: z.literal("CLOSING"),
      conditions: z.array(ClosureCondition).max(10),
      requestedAtSim: SimInstant,
    })
    .strict(),
);
export type ClosureResult = z.infer<typeof ClosureResult>;

export const DataChangeField = core("DataChangeField", z.enum(["EMAIL", "ADDRESS", "PHONE"]));
export type DataChangeField = z.infer<typeof DataChangeField>;

/** `newValue` is extracted by code from the customer's message, never written by the model. */
export const DataChangeRequest = core(
  "DataChangeRequest",
  z
    .object({
      complaintId: ResourceId,
      idempotencyKey: IdempotencyKey,
      field: DataChangeField,
      newValue: z.string().min(1).max(200).optional(),
    })
    .strict(),
);
export type DataChangeRequest = z.infer<typeof DataChangeRequest>;

export const DataChangeResult = core(
  "DataChangeResult",
  z
    .object({
      actionId: ResourceId,
      field: DataChangeField,
      status: z.enum(["PENDING_CONFIRMATION", "REFERRED"]),
      confirmationToMasked: z.string().min(1).max(120).optional(),
    })
    .strict(),
);
export type DataChangeResult = z.infer<typeof DataChangeResult>;
