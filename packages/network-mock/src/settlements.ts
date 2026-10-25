// The collection networks (docs/architecture-integrations.md §6.1): an in-person payment goes to the
// batch of its business date (cut-off, weekends and holidays of the world); the batch is published
// as a CSV in `Settlements` with its SHA-256, and every batch carries other payers' payments. Time is
// the world's simulated instant the caller sent (`X-Sim-Now`), never a clock (ADR-0011).
//
// Every write is conditional and retried a bounded number of times on a concurrent change: a
// collection that races a publication either lands in the file or is refused (409), never lost.
import { createHash } from "node:crypto";
import {
  type CollectionNetwork,
  type CollectionRequest,
  type CollectionResult,
  type PublishResult,
  SettlementBatch,
  type SettlementBatchList,
  type SettlementLine,
  type SettlementsQuery,
  formatSettlementCsv,
} from "@reclamo/core-contract";
import { addCalendarDays, compareDates } from "@reclamo/shared";
import { addMinutes, businessDateOf, isBefore, publishAtOf } from "./business-date";
import { NetworkError, NetworkUnavailableError } from "./errors";
import { lateMinutes, missingLineFaults } from "./faults";
import { otherPayerLines } from "./other-payers";
import { DEFAULT_SETTLEMENT_DELAYS, type SettlementDelay, type StoredBatch, type StoredLine } from "./store/items";
import type { NetworkStore, SettlementObjects } from "./store/port";
import type { WorldContext } from "./world-context";
import { settlementKey } from "./world-root";

/** Bounded retries of an optimistic write that met a concurrent change. */
const ATTEMPTS = 3;
/** `listSettlements` covers at most 31 business dates (networks.openapi.yaml). */
const MAX_RANGE_DAYS = 31;

export interface SettlementDeps {
  readonly store: NetworkStore;
  readonly objects: SettlementObjects;
}

export function delayOf(context: WorldContext, network: CollectionNetwork): SettlementDelay {
  return context.world.settlementDelays[network] ?? DEFAULT_SETTLEMENT_DELAYS[network];
}

/** The contract's view of a stored batch. */
export function toContractBatch(batch: StoredBatch): SettlementBatch {
  return SettlementBatch.parse({
    network: batch.network,
    businessDate: batch.businessDate,
    status: batch.status,
    publishAtSim: batch.publishAtSim,
    ...(batch.publishedAtSim === undefined ? {} : { publishedAtSim: batch.publishedAtSim }),
    ...(batch.s3Key === undefined ? {} : { s3Key: batch.s3Key }),
    ...(batch.lineCount === undefined ? {} : { lineCount: batch.lineCount }),
    ...(batch.sha256 === undefined ? {} : { sha256: batch.sha256 }),
  });
}

function sameLine(a: SettlementLine, b: SettlementLine): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

function byPaidAtThenCode(a: StoredLine, b: StoredLine): number {
  const time = Date.parse(a.line.paidAt) - Date.parse(b.line.paidAt);
  if (time !== 0) return time;
  return a.line.operationCode < b.line.operationCode ? -1 : a.line.operationCode > b.line.operationCode ? 1 : 0;
}

export function createSettlements(deps: SettlementDeps) {
  const { store, objects } = deps;

  async function batchOrNotFound(context: WorldContext, network: CollectionNetwork, businessDate: string): Promise<StoredBatch> {
    const batch = await store.getBatch(context.worldId, network, businessDate);
    if (batch === undefined) throw new NetworkError("NOT_FOUND", "no batch for this network and business date");
    return batch;
  }

  /** The lines a published file carries: the batch's, minus the `MISSING_LINE` faults, in time order. */
  function publishedLines(context: WorldContext, batch: StoredBatch, lines: StoredLine[]): StoredLine[] {
    const sorted = [...lines].sort(byPaidAtThenCode);
    const omitted = new Set<string>();
    for (const fault of missingLineFaults(context.worldId, context.faults, batch.network, batch.businessDate)) {
      const code = fault.operationCode ?? sorted.find((line) => line.origin !== "OTHER_PAYER" && !omitted.has(line.line.operationCode))?.line.operationCode;
      if (code !== undefined) omitted.add(code);
    }
    return sorted.filter((line) => !omitted.has(line.line.operationCode));
  }

  return {
    async registerCollection(context: WorldContext, request: CollectionRequest): Promise<CollectionResult> {
      if (isBefore(context.simNow, request.paidAtSim)) throw new NetworkError("INVALID", "a payment cannot be registered before it is made");
      const { network, operationCode } = request;
      const delay = delayOf(context, network);
      const businessDate = businessDateOf(request.paidAtSim, delay, context.world.holidays);
      const line: SettlementLine = { network, businessDate, operationCode, paidAt: request.paidAtSim, amount: request.amount, customerRef: request.customerRef, loanRef: request.loanRef, instalment: request.instalment, terminal: request.terminal };
      const result = (batch: StoredBatch, batchCreated: boolean): CollectionResult => ({ network, operationCode, businessDate, batch: toContractBatch(batch), batchCreated });

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const claimed = await store.getCodeClaim(context.worldId, network, operationCode);
        if (claimed !== undefined) {
          // The same registration retried answers what it answered; any other use of the code is a conflict.
          if (claimed.origin !== "COLLECTION" || !sameLine(claimed.line, line)) throw new NetworkError("CONFLICT", "the operation code already exists in this network");
          return result(await batchOrNotFound(context, network, businessDate), claimed.createdBatch);
        }
        const batch = await store.getBatch(context.worldId, network, businessDate);
        if (batch?.status === "PUBLISHED") throw new NetworkError("CONFLICT", "the batch of this business date is already published");
        if (batch === undefined) {
          const created: StoredBatch = { worldId: context.worldId, network, businessDate, status: "PENDING", publishAtSim: publishAtOf(businessDate, delay, context.world.holidays), seq: 1, deferred: false, version: 1 };
          const others = otherPayerLines(context.worldId, network, businessDate).map((other): StoredLine => ({ worldId: context.worldId, line: other, origin: "OTHER_PAYER", createdBatch: false }));
          const outcome = await store.writeCollection({ worldId: context.worldId, network, businessDate, batch: { create: created }, lines: [{ worldId: context.worldId, line, origin: "COLLECTION", createdBatch: true }, ...others] });
          if (outcome === "OK") return result(created, true);
          continue;
        }
        const outcome = await store.writeCollection({ worldId: context.worldId, network, businessDate, batch: { expectVersion: batch.version }, lines: [{ worldId: context.worldId, line, origin: "COLLECTION", createdBatch: false }] });
        if (outcome === "OK") return result({ ...batch, version: batch.version + 1 }, false);
      }
      throw new NetworkUnavailableError("the batch kept changing; retry");
    },

    async publishSettlement(context: WorldContext, network: CollectionNetwork, businessDate: string): Promise<PublishResult> {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const batch = await batchOrNotFound(context, network, businessDate);
        if (batch.status === "PUBLISHED") return { outcome: "ALREADY_PUBLISHED", batch: toContractBatch(batch) };

        const late = lateMinutes(context.worldId, context.faults, network, businessDate);
        if (late > 0 && !batch.deferred) {
          const publishAtSim = addMinutes(batch.publishAtSim, late);
          if ((await store.deferBatch(batch, publishAtSim)) === "OK") return { outcome: "DEFERRED", batch: toContractBatch({ ...batch, publishAtSim, deferred: true }) };
          continue;
        }
        if (batch.deferred && isBefore(context.simNow, batch.publishAtSim)) return { outcome: "DEFERRED", batch: toContractBatch(batch) };

        const lines = publishedLines(context, batch, await store.listLines(context.worldId, network, businessDate));
        const csv = formatSettlementCsv(lines.map((stored) => stored.line));
        const publication = {
          publishedAtSim: context.simNow,
          s3Key: settlementKey(context.worldId, network, businessDate, batch.seq),
          lineCount: lines.length,
          sha256: createHash("sha256").update(csv, "utf8").digest("hex"),
        };
        // The file first: a status update that fails leaves a file that the retry rewrites byte for byte.
        await objects.put(publication.s3Key, csv);
        if ((await store.markPublished(batch, publication)) === "OK") {
          return { outcome: "PUBLISHED", batch: toContractBatch({ ...batch, ...publication, status: "PUBLISHED" }) };
        }
      }
      throw new NetworkUnavailableError("the batch kept changing; retry");
    },

    async listSettlements(context: WorldContext, network: CollectionNetwork, query: SettlementsQuery): Promise<SettlementBatchList> {
      if (compareDates(query.from, query.to) > 0 || compareDates(query.to, addCalendarDays(query.from, MAX_RANGE_DAYS - 1)) > 0) {
        throw new NetworkError("INVALID", `the range covers 1 to ${MAX_RANGE_DAYS} days`);
      }
      const batches = await store.listBatches(context.worldId, network, query.from, query.to);
      return { network, batches: batches.map(toContractBatch) };
    },
  };
}

export type Settlements = ReturnType<typeof createSettlements>;
