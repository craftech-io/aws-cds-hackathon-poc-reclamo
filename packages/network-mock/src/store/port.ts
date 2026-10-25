// The storage port of the network mock: the reads and the conditional writes the services need,
// each write being one atomic step. Two adapters implement it: DynamoDB (store/dynamo.ts, the Lambda)
// and memory (store/memory.ts, unit tests and the local flows), with the same semantics.
import type { CollectionNetwork, SettlementBatch } from "@reclamo/core-contract";
import type { Fault } from "../faults";
import type { NetworkWorld, ReversalClaim, StoredBatch, StoredLine, StoredTransfer } from "./items";

/** Registers one collection atomically: either all of it is written or nothing is. */
export interface CollectionWrite {
  readonly worldId: string;
  readonly network: CollectionNetwork;
  readonly businessDate: string;
  /** The collection, its code's claim and, when the batch is opened, the other payers. */
  readonly lines: readonly StoredLine[];
  /** Open the batch (it must not exist) or touch the existing one (still `PENDING`, at this version). */
  readonly batch: { readonly create: StoredBatch } | { readonly expectVersion: number };
}

/** Why an atomic write did not happen. */
export type WriteOutcome = "OK" | "CODE_TAKEN" | "STALE";

export interface Publication {
  readonly publishedAtSim: string;
  readonly s3Key: NonNullable<SettlementBatch["s3Key"]>;
  readonly lineCount: number;
  readonly sha256: string;
}

export interface NetworkStore {
  getWorld(worldId: string): Promise<NetworkWorld | undefined>;
  getFaults(worldId: string): Promise<Fault[]>;

  getBatch(worldId: string, network: CollectionNetwork, businessDate: string): Promise<StoredBatch | undefined>;
  /** Batches of business dates `from`…`to` (inclusive), in date order. */
  listBatches(worldId: string, network: CollectionNetwork, from: string, to: string): Promise<StoredBatch[]>;
  /** Every line of a batch (all pages). */
  listLines(worldId: string, network: CollectionNetwork, businessDate: string): Promise<StoredLine[]>;
  /** The line that holds a code in a network, with its origin and whether it opened its batch. */
  getCodeClaim(worldId: string, network: CollectionNetwork, operationCode: string): Promise<StoredLine | undefined>;
  /** `CODE_TAKEN` when any code is already claimed; `STALE` when the batch is not as expected. */
  writeCollection(write: CollectionWrite): Promise<WriteOutcome>;
  /** Moves `publishAtSim` once (`LATE_PUBLISH`), at this version of a `PENDING` batch. */
  deferBatch(batch: StoredBatch, publishAtSim: string): Promise<WriteOutcome>;
  /** `PENDING` → `PUBLISHED`, at this version. */
  markPublished(batch: StoredBatch, publication: Publication): Promise<WriteOutcome>;

  getTransfer(worldId: string, transferId: string): Promise<StoredTransfer | undefined>;
  /** Replaces a transfer's status at its stored version. */
  updateTransfer(next: StoredTransfer, expectVersion: number): Promise<WriteOutcome>;
  getReversalClaim(worldId: string, transferId: string): Promise<ReversalClaim | undefined>;
  /** Takes the `TRV#` claim and moves the transfer in one step: `CODE_TAKEN` when claimed, `STALE` when moved. */
  reverseTransfer(claim: ReversalClaim, next: StoredTransfer, expectVersion: number): Promise<WriteOutcome>;
}

/** The bucket of the settlement files (`Settlements`). */
export interface SettlementObjects {
  put(key: string, body: string): Promise<void>;
}
