// Simulated networks (docs/architecture-integrations.md §6): the two collection networks with
// their settlement batches, and the transfer network with its status API. The CSV row of a
// settlement file is `SettlementLine` (codec in settlement-csv.ts).
import { z } from "zod";
import { CalendarDate, Cents, CustomerId, IdempotencyKey, InstalmentNumber, LoanId, OperationCode, PositiveCents, ResourceId, SimInstant } from "./common";
import { networks } from "./registry";

export const CollectionNetwork = networks("CollectionNetwork", z.enum(["NORTE", "SUR"]));
export type CollectionNetwork = z.infer<typeof CollectionNetwork>;

export const Terminal = networks("Terminal", z.string().regex(/^T-\d{4}$/));
export type Terminal = z.infer<typeof Terminal>;

export const Sha256Hex = networks("Sha256Hex", z.string().regex(/^[0-9a-f]{64}$/));
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** `<world root>/<network>/<businessDate>/batch-<seq>.csv` in the `Settlements` bucket (docs/architecture.md §6). */
export const SettlementKey = networks("SettlementKey", z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,500}\/(NORTE|SUR)\/\d{4}-\d{2}-\d{2}\/batch-\d+\.csv$/));
export type SettlementKey = z.infer<typeof SettlementKey>;

/** One row of a settlement file; a batch also carries payments of customers who are not personas. */
export const SettlementLine = networks(
  "SettlementLine",
  z
    .object({
      network: CollectionNetwork,
      businessDate: CalendarDate,
      operationCode: OperationCode,
      paidAt: SimInstant,
      amount: PositiveCents,
      customerRef: CustomerId,
      loanRef: LoanId,
      instalment: InstalmentNumber,
      terminal: Terminal,
    })
    .strict(),
);
export type SettlementLine = z.infer<typeof SettlementLine>;

export const CollectionRequest = networks(
  "CollectionRequest",
  z
    .object({
      network: CollectionNetwork,
      operationCode: OperationCode,
      paidAtSim: SimInstant,
      amount: PositiveCents,
      customerRef: CustomerId,
      loanRef: LoanId,
      instalment: InstalmentNumber,
      terminal: Terminal,
    })
    .strict(),
);
export type CollectionRequest = z.infer<typeof CollectionRequest>;

export const BatchStatus = networks("BatchStatus", z.enum(["PENDING", "PUBLISHED"]));
export type BatchStatus = z.infer<typeof BatchStatus>;

/** `s3Key`, `lineCount`, `sha256` and `publishedAtSim` are present once the batch is `PUBLISHED`. */
export const SettlementBatch = networks(
  "SettlementBatch",
  z
    .object({
      network: CollectionNetwork,
      businessDate: CalendarDate,
      status: BatchStatus,
      publishAtSim: SimInstant,
      publishedAtSim: SimInstant.optional(),
      s3Key: SettlementKey.optional(),
      lineCount: z.number().int().min(0).max(5000).optional(),
      sha256: Sha256Hex.optional(),
    })
    .strict(),
);
export type SettlementBatch = z.infer<typeof SettlementBatch>;

/** The caller creates the `SETTLEMENT_PUBLISH` timer at `batch.publishAtSim` when `batchCreated`. */
export const CollectionResult = networks(
  "CollectionResult",
  z
    .object({
      network: CollectionNetwork,
      operationCode: OperationCode,
      businessDate: CalendarDate,
      batch: SettlementBatch,
      batchCreated: z.boolean(),
    })
    .strict(),
);
export type CollectionResult = z.infer<typeof CollectionResult>;

export const PublishResult = networks(
  "PublishResult",
  z.object({ outcome: z.enum(["PUBLISHED", "ALREADY_PUBLISHED", "DEFERRED"]), batch: SettlementBatch }).strict(),
);
export type PublishResult = z.infer<typeof PublishResult>;

export const SettlementsQuery = z.object({ from: CalendarDate, to: CalendarDate }).strict();
export type SettlementsQuery = z.infer<typeof SettlementsQuery>;

export const SettlementBatchList = networks(
  "SettlementBatchList",
  z.object({ network: CollectionNetwork, batches: z.array(SettlementBatch).max(100) }).strict(),
);
export type SettlementBatchList = z.infer<typeof SettlementBatchList>;

export const TransferState = networks(
  "TransferState",
  z.enum(["COMPLETED", "PENDING", "REJECTED_REVERSED", "REJECTED_NOT_REVERSED", "UNKNOWN"]),
);
export type TransferState = z.infer<typeof TransferState>;

/** `rejectReason` is free text of the network: the tools return it escaped, as data. */
export const TransferStatus = networks(
  "TransferStatus",
  z
    .object({
      transferId: ResourceId,
      status: TransferState,
      traceId: z.string().max(40).regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/).optional(),
      completedAtSim: SimInstant.optional(),
      expectedBySim: SimInstant.optional(),
      rejectReason: z.string().min(1).max(200).optional(),
      reversedAtSim: SimInstant.optional(),
    })
    .strict(),
);
export type TransferStatus = z.infer<typeof TransferStatus>;

export const TransferReversalRequest = networks(
  "TransferReversalRequest",
  z.object({ customerId: CustomerId, complaintId: ResourceId, idempotencyKey: IdempotencyKey, cap: Cents }).strict(),
);
export type TransferReversalRequest = z.infer<typeof TransferReversalRequest>;

export const TransferReversalResult = networks(
  "TransferReversalResult",
  z
    .object({
      actionId: ResourceId,
      transferId: ResourceId,
      status: z.literal("REJECTED_REVERSED"),
      amount: PositiveCents,
      reversedAtSim: SimInstant,
    })
    .strict(),
);
export type TransferReversalResult = z.infer<typeof TransferReversalResult>;

export const TransitionRequest = networks(
  "TransitionRequest",
  z
    .object({
      to: z.enum(["COMPLETED", "REJECTED_REVERSED", "REJECTED_NOT_REVERSED"]),
      rejectReason: z.string().min(1).max(200).optional(),
    })
    .strict(),
);
export type TransitionRequest = z.infer<typeof TransitionRequest>;
