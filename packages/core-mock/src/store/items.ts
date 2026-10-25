// The items of the `Core` table (docs/architecture.md §5) as zod schemas, keyed by their `entity`
// tag. They are the format the seed writes and the ledger reads: a stored item that does not match
// its schema never reaches the ledger as if it did. Storage attributes (`pk`, `sk`, `version`,
// stamps, index keys, `expiresAt`) are read apart (store/codec.ts); unknown attributes are dropped.
//
// Amounts are integer centavos, instants are ISO 8601 with offset in the world's simulated time.
// What never leaves the core (`liveE164`, the hashes, the full CVU) lives here and has no field in
// the contract (packages/core-contract).
import {
  AccountStatus,
  BlockCategory,
  CalendarDate,
  Cents,
  ClosureCondition,
  CustomerId,
  DataChangeField,
  DisbursementStatus,
  FeeCode,
  IdempotencyKey,
  InstalmentNumber,
  LoanId,
  LoanStatus,
  OperationCode,
  OperationKind,
  OperationRef,
  OperationStatus,
  PaymentNetwork,
  PaymentSource,
  PhoneHash,
  PositiveCents,
  ResourceId,
  SimInstant,
  TransferState,
  WhatsAppConsent,
} from "@reclamo/core-contract";
import { z } from "zod";

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Masked = z.string().min(1).max(120);

export const CustomerItem = z.object({
  entity: z.literal("Customer"),
  customerId: CustomerId,
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  docType: z.literal("DNI"),
  docNumberMasked: z.string().regex(/^•{4}\d{4}$/),
  phoneHash: PhoneHash,
  phoneMasked: z.string().min(1).max(32),
  emailMasked: Masked,
  emailHash: Hash.optional(),
  /** Only in `demo` and the live QA world; only the live WhatsApp transport reads it. */
  liveE164: z.string().regex(/^\+\d{8,15}$/).optional(),
  whatsapp: WhatsAppConsent,
});
export type CustomerItem = z.infer<typeof CustomerItem>;

export const ClosureRecord = z.object({
  actionId: ResourceId,
  complaintId: ResourceId,
  idempotencyKey: IdempotencyKey,
  requestedAtSim: SimInstant,
  conditions: z.array(ClosureCondition).max(10),
});
export type ClosureRecord = z.infer<typeof ClosureRecord>;

export const DataChangeRecord = z.object({
  actionId: ResourceId,
  complaintId: ResourceId,
  idempotencyKey: IdempotencyKey,
  field: DataChangeField,
  status: z.enum(["PENDING_CONFIRMATION", "REFERRED", "SUPERSEDED"]),
  newValueMasked: Masked.optional(),
  newValueHash: Hash.optional(),
  confirmationToMasked: Masked.optional(),
  requestedAtSim: SimInstant,
});
export type DataChangeRecord = z.infer<typeof DataChangeRecord>;

export const AccountItem = z.object({
  entity: z.literal("Account"),
  customerId: CustomerId,
  status: AccountStatus,
  blockCategory: BlockCategory.optional(),
  closure: ClosureRecord.optional(),
  dataChanges: z.array(DataChangeRecord).max(20).default([]),
});
export type AccountItem = z.infer<typeof AccountItem>;

export const FreezeBy = z.enum(["AGENT", "STAFF", "SYSTEM"]);
export type FreezeBy = z.infer<typeof FreezeBy>;

export const FreezeEvent = z.object({
  actionId: ResourceId,
  idempotencyKey: IdempotencyKey,
  active: z.boolean(),
  by: FreezeBy,
  reason: z.enum(["UNKNOWN_OPERATION", "CUSTOMER_REQUEST", "STAFF_DECISION"]),
  complaintId: ResourceId.optional(),
  atSim: SimInstant,
});
export type FreezeEvent = z.infer<typeof FreezeEvent>;

export const WalletItem = z.object({
  entity: z.literal("Wallet"),
  customerId: CustomerId,
  balance: Cents,
  /** 22 digits: `9990` + 18 derived from the customer id (docs/seed-spec.md §5). */
  syntheticCvu: z.string().regex(/^\d{22}$/),
  freeze: z
    .object({ active: z.boolean(), atSim: SimInstant.optional(), by: FreezeBy.optional(), history: z.array(FreezeEvent).max(50).default([]) })
    .default({ active: false, history: [] }),
});
export type WalletItem = z.infer<typeof WalletItem>;

export const DisbursementRecord = z.object({
  status: DisbursementStatus,
  gross: PositiveCents,
  originationFee: Cents,
  net: Cents,
  creditedAtSim: SimInstant.optional(),
  expectedBySim: SimInstant.optional(),
  returnedAtSim: SimInstant.optional(),
});

export const LoanItem = z.object({
  entity: z.literal("Loan"),
  loanId: LoanId,
  customerId: CustomerId,
  label: z.string().min(1).max(80),
  principal: PositiveCents,
  instalmentsCount: z.number().int().min(3).max(18),
  /** Nominal annual compensatory rate as a fraction (0.95 = 95 %). */
  annualRate: z.number().min(0).max(10),
  /** Stored only once final (`CANCELLED`, `EARLY_CANCELLED`); `ACTIVE`/`IN_ARREARS` are derived at read time. */
  status: LoanStatus,
  disbursedAtSim: SimInstant.optional(),
  cancelledAtSim: SimInstant.optional(),
  disbursement: DisbursementRecord.optional(),
});
export type LoanItem = z.infer<typeof LoanItem>;

export const InstalmentItem = z.object({
  entity: z.literal("Instalment"),
  loanId: LoanId,
  number: InstalmentNumber,
  dueDate: CalendarDate,
  principal: Cents,
  interest: Cents,
  vat: Cents,
  /** principal + interest + vat. */
  amount: PositiveCents,
  /** Late interest (`T-3.2`, `T-3.4`) accrued on the instalment; owed on top of `amount`. */
  lateInterest: Cents.default(0),
  /** Total applied to the instalment so far. */
  paid: Cents.default(0),
});
export type InstalmentItem = z.infer<typeof InstalmentItem>;

export const Allocation = z.object({ instalment: InstalmentNumber, amount: PositiveCents });

export const PaymentItem = z.object({
  entity: z.literal("Payment"),
  paymentId: ResourceId,
  loanId: LoanId,
  customerId: CustomerId,
  network: PaymentNetwork,
  operationCode: OperationCode,
  amount: PositiveCents,
  paidAtSim: SimInstant,
  appliedAtSim: SimInstant,
  source: PaymentSource,
  allocations: z.array(Allocation).min(1).max(18),
  lateInterest: Cents.default(0),
  complaintId: ResourceId.optional(),
  actionId: ResourceId.optional(),
  /** `ByOperationCode` partition. */
  opCodeKey: z.string().min(1),
});
export type PaymentItem = z.infer<typeof PaymentItem>;

/** One operation of the customer (wallet movements, payments, charges, debits, transfers, credits). */
export const MovementItem = z.object({
  entity: z.literal("Movement"),
  movementId: ResourceId,
  customerId: CustomerId,
  kind: OperationKind,
  atSim: SimInstant,
  amount: Cents,
  direction: z.enum(["IN", "OUT"]),
  description: z.string().min(1).max(140),
  status: OperationStatus,
  ref: OperationRef.default({}),
});
export type MovementItem = z.infer<typeof MovementItem>;

export const ChargeReversalRecord = z.object({
  actionId: ResourceId,
  creditNoteId: ResourceId,
  complaintId: ResourceId,
  amount: PositiveCents,
  compensatoryInterest: Cents,
  creditedAtSim: SimInstant,
});

export const ChargeItem = z.object({
  entity: z.literal("Charge"),
  chargeId: ResourceId,
  customerId: CustomerId,
  loanId: LoanId.optional(),
  instalment: InstalmentNumber.optional(),
  feeCode: FeeCode,
  amount: PositiveCents,
  chargedAtSim: SimInstant,
  scheduleVersion: z.string().regex(/^v\d{3}$/).default("v001"),
  /** `FEE-CARD-REPL`: the customer asked for the replacement card (`CardRequest`). */
  requested: z.boolean().optional(),
  /** `FEE-EARLY`: principal cancelled early, the base of the 2 %. */
  basisAmount: Cents.optional(),
  reversal: ChargeReversalRecord.optional(),
});
export type ChargeItem = z.infer<typeof ChargeItem>;

export const TransferItem = z.object({
  entity: z.literal("Transfer"),
  transferId: ResourceId,
  customerId: CustomerId,
  direction: z.enum(["IN", "OUT"]),
  amount: PositiveCents,
  atSim: SimInstant,
  status: TransferState,
  counterpartMasked: z.string().min(1).max(60).optional(),
});
export type TransferItem = z.infer<typeof TransferItem>;

export const CreditNoteItem = z.object({
  entity: z.literal("CreditNote"),
  creditNoteId: ResourceId,
  customerId: CustomerId,
  kind: z.enum(["CHARGE_REVERSAL", "DUPLICATE_REFUND", "TRANSFER_REVERSAL"]),
  /** The charge, debit or transfer the credit note answers. */
  sourceId: ResourceId,
  amount: PositiveCents,
  compensatoryInterest: Cents,
  complaintId: ResourceId,
  actionId: ResourceId,
  creditedAtSim: SimInstant,
});
export type CreditNoteItem = z.infer<typeof CreditNoteItem>;

export const PayoffQuoteItem = z.object({
  entity: z.literal("PayoffQuote"),
  quoteId: ResourceId,
  loanId: LoanId,
  customerId: CustomerId,
  principal: Cents,
  accruedInterest: Cents,
  fee: Cents,
  feeClauseId: z.string().optional(),
  total: Cents,
  asOfSim: SimInstant,
  validUntilSim: SimInstant,
});
export type PayoffQuoteItem = z.infer<typeof PayoffQuoteItem>;

export const PhoneClaimItem = z.object({ entity: z.literal("PhoneClaim"), customerId: CustomerId });
export const OwnerItem = z.object({ entity: z.enum(["LoanOwner", "ChargeOwner"]), customerId: CustomerId });

/** Natural-key claim of a money action, taken in the transaction that moves the money. */
export const ActionClaimItem = z.object({
  entity: z.literal("ActionClaim"),
  kind: z.enum(["OPC", "REV", "RFD", "TRV"]),
  actionId: ResourceId,
  customerId: CustomerId,
  complaintId: ResourceId,
  amount: Cents,
  idempotencyKey: IdempotencyKey,
  /** The answer of the action, replayed to a retry with the same idempotency key. */
  result: z.record(z.string(), z.unknown()).optional(),
});
export type ActionClaimItem = z.infer<typeof ActionClaimItem>;

/** Items of a customer partition, by entity tag. */
export const CUSTOMER_ENTITIES = {
  Customer: CustomerItem,
  Account: AccountItem,
  Wallet: WalletItem,
  Loan: LoanItem,
  Instalment: InstalmentItem,
  Payment: PaymentItem,
  Movement: MovementItem,
  Charge: ChargeItem,
  Transfer: TransferItem,
  CreditNote: CreditNoteItem,
  PayoffQuote: PayoffQuoteItem,
} as const;
export type CustomerEntity = keyof typeof CUSTOMER_ENTITIES;
