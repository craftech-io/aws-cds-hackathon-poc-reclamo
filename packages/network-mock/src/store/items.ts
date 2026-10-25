// What the network mock keeps in its table `Networks` (docs/architecture.md §5): one schema per
// entity, the keys, and the builders of the raw items. The world factory and the seed write a
// world's network items with these builders (the templates carry final keys, docs/seed-spec.md §4),
// the QA driver's `network.setDelay` / `network.setFault` write `CONFIG` and `FAULTS`, and the
// stores below read and write them. Every partition starts with `W#<worldId>#`.
//
//   W#<w>#NET#WORLD           CONFIG                       holidays and settlement delays of the world
//   W#<w>#NET#WORLD           FAULTS                       faults of the world (faults.ts)
//   W#<w>#NET#<network>       BATCH#<businessDate>         settlement batch
//   W#<w>#NET#<network>       LINE#<businessDate>#<code>   one payment of a batch
//   W#<w>#NET#<network>       OPC#<code>                   the code is taken in this network
//   W#<w>#TRF#<transferId>    STATUS                       transfer status in the transfer network
//   W#<w>#TRV#<transferId>    CLAIM                        the one reversal of a transfer
import { CalendarDate, CollectionNetwork, CustomerId, PositiveCents, ResourceId, SettlementBatch, SettlementLine, SimInstant, TransferState, WorldId } from "@reclamo/core-contract";
import { worldKindOf } from "@reclamo/shared";
import { z } from "zod";
import { Fault } from "../faults";

export const TABLE = "Networks";
export const WORLD_PARTITION = "NET#WORLD";
export const CONFIG_SK = "CONFIG";
export const FAULTS_SK = "FAULTS";
export const STATUS_SK = "STATUS";
export const CLAIM_SK = "CLAIM";

/** An id inside a key: no `#`, `/` or whitespace, so nothing can address another item or world. */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function part(value: string, label: string): string {
  if (!KEY_SEGMENT.test(value)) throw new RangeError(`invalid ${label} for a key`);
  return value;
}

function prefix(worldId: string): string {
  return `W#${WorldId.parse(worldId)}#`;
}

export interface Key {
  readonly pk: string;
  readonly sk: string;
}

export const keys = {
  worldPrefix: prefix,
  config: (worldId: string): Key => ({ pk: `${prefix(worldId)}${WORLD_PARTITION}`, sk: CONFIG_SK }),
  faults: (worldId: string): Key => ({ pk: `${prefix(worldId)}${WORLD_PARTITION}`, sk: FAULTS_SK }),
  network: (worldId: string, network: CollectionNetwork): string => `${prefix(worldId)}NET#${CollectionNetwork.parse(network)}`,
  batch: (worldId: string, network: CollectionNetwork, businessDate: string): Key => ({ pk: keys.network(worldId, network), sk: `BATCH#${CalendarDate.parse(businessDate)}` }),
  batchPrefix: "BATCH#",
  line: (worldId: string, network: CollectionNetwork, businessDate: string, code: string): Key => ({
    pk: keys.network(worldId, network),
    sk: `LINE#${CalendarDate.parse(businessDate)}#${part(code, "operation code")}`,
  }),
  linePrefix: (businessDate: string): string => `LINE#${CalendarDate.parse(businessDate)}#`,
  operationCode: (worldId: string, network: CollectionNetwork, code: string): Key => ({ pk: keys.network(worldId, network), sk: `OPC#${part(code, "operation code")}` }),
  transfer: (worldId: string, transferId: string): Key => ({ pk: `${prefix(worldId)}TRF#${part(transferId, "transfer id")}`, sk: STATUS_SK }),
  reversalClaim: (worldId: string, transferId: string): Key => ({ pk: `${prefix(worldId)}TRV#${part(transferId, "transfer id")}`, sk: CLAIM_SK }),
};

/** "HH:MM" in Argentina time (UTC-3 all year). */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Same shape as `WorldSettings.settlementDelays` of the world (packages/bff/src/domain/world.ts). */
export const SettlementDelay = z.object({ businessDays: z.number().int().min(0).max(10), publishAt: ClockTime, cutoff: ClockTime }).strict();
export type SettlementDelay = z.infer<typeof SettlementDelay>;

/** docs/architecture-integrations.md §6.1: NORTE cut-off 18:00, D+1 at 08:30; SUR 16:00, D+2 at 11:00. */
export const DEFAULT_SETTLEMENT_DELAYS: Readonly<Record<CollectionNetwork, SettlementDelay>> = {
  NORTE: { businessDays: 1, publishAt: "08:30", cutoff: "18:00" },
  SUR: { businessDays: 2, publishAt: "11:00", cutoff: "16:00" },
};

/** `CONFIG`: the world exists for the networks. Holidays are copied from `Reference/HOLIDAY#AR` by the factory. */
export const NetworkWorld = z
  .object({
    worldId: WorldId,
    holidays: z.array(CalendarDate).max(400),
    settlementDelays: z.partialRecord(CollectionNetwork, SettlementDelay).default({}),
    version: z.number().int().min(1),
  })
  .strict();
export type NetworkWorld = z.infer<typeof NetworkWorld>;

export const FaultsItem = z.object({ worldId: WorldId, faults: z.array(Fault).max(20), version: z.number().int().min(1) }).strict();
export type FaultsItem = z.infer<typeof FaultsItem>;

/** A batch as stored: the contract's `SettlementBatch` plus its file sequence and the fault bookkeeping. */
export const StoredBatch = z
  .object({
    ...SettlementBatch.shape,
    worldId: WorldId,
    seq: z.number().int().min(1).max(99),
    /** `LATE_PUBLISH` already moved `publishAtSim` once. */
    deferred: z.boolean().default(false),
    version: z.number().int().min(1),
  })
  .strict();
export type StoredBatch = z.infer<typeof StoredBatch>;

/** Where a line came from: a registered collection, the template, or the mock's other payers. */
export const LineOrigin = z.enum(["COLLECTION", "SEED", "OTHER_PAYER"]);
export type LineOrigin = z.infer<typeof LineOrigin>;

export const StoredLine = z
  .object({
    worldId: WorldId,
    line: SettlementLine,
    origin: LineOrigin,
    /** The registration of this line created its batch (replayed to an idempotent retry). */
    createdBatch: z.boolean().default(false),
  })
  .strict();
export type StoredLine = z.infer<typeof StoredLine>;

export const TransferDirection = z.enum(["IN", "OUT"]);

/** Transfer states a transfer can be stored in (`UNKNOWN` is the answer for a missing one). */
export const KnownTransferState = TransferState.exclude(["UNKNOWN"]);
export type KnownTransferState = z.infer<typeof KnownTransferState>;

export const TransitionRecord = z
  .object({ from: KnownTransferState, to: KnownTransferState, atSim: SimInstant, by: z.enum(["TRANSITION", "REVERSAL"]) })
  .strict();

export const StoredTransfer = z
  .object({
    worldId: WorldId,
    transferId: ResourceId,
    customerId: CustomerId,
    direction: TransferDirection,
    amount: PositiveCents,
    status: KnownTransferState,
    traceId: z.string().max(40).regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/).optional(),
    completedAtSim: SimInstant.optional(),
    expectedBySim: SimInstant.optional(),
    rejectReason: z.string().min(1).max(200).optional(),
    reversedAtSim: SimInstant.optional(),
    transitions: z.array(TransitionRecord).max(20).default([]),
    version: z.number().int().min(1),
  })
  .strict();
export type StoredTransfer = z.infer<typeof StoredTransfer>;

export const ReversalClaim = z
  .object({
    worldId: WorldId,
    transferId: ResourceId,
    actionId: ResourceId,
    customerId: CustomerId,
    complaintId: ResourceId,
    idempotencyKey: z.string().min(1).max(128),
    amount: PositiveCents,
    reversedAtSim: SimInstant,
  })
  .strict();
export type ReversalClaim = z.infer<typeof ReversalClaim>;

const ENTITY = {
  config: "NetworkWorld",
  faults: "NetworkFaults",
  batch: "SettlementBatch",
  line: "SettlementLine",
  operationCode: "OperationCodeClaim",
  transfer: "TransferStatus",
  reversalClaim: "TransferReversalClaim",
} as const;
export type EntityName = (typeof ENTITY)[keyof typeof ENTITY];

const DAY_SECONDS = 86_400;

/**
 * `expiresAt` (real time, epoch seconds) of a network item: QA and simulated-load worlds 2 days,
 * guest worlds 90 days, `demo` never (the same retention the connector gives `Core`).
 */
export function expiresAtFor(worldId: string, realNow: Date): number | undefined {
  const kind = worldKindOf(worldId);
  const days = kind === "QA" || kind === "SIM" ? 2 : kind === "GUEST" ? 90 : undefined;
  return days === undefined ? undefined : Math.floor(realNow.getTime() / 1000) + days * DAY_SECONDS;
}

/** A raw item: key, entity tag, `WorldIndex` attributes, stamps and TTL around the entity's fields. */
export function rawItem(entity: EntityName, worldId: string, key: Key, fields: object, realNow: Date): Record<string, unknown> {
  const expiresAt = expiresAtFor(worldId, realNow);
  const stamp = realNow.toISOString();
  return {
    ...fields,
    pk: key.pk,
    sk: key.sk,
    entity,
    worldId,
    worldIndexKey: prefix(worldId),
    worldIndexSort: `${key.pk}|${key.sk}`,
    createdAt: stamp,
    updatedAt: stamp,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Builders of the raw items, for the world factory, the seed and the QA driver. */
export const items = {
  config: (world: z.input<typeof NetworkWorld>, realNow: Date) => {
    const parsed = NetworkWorld.parse(world);
    return rawItem(ENTITY.config, parsed.worldId, keys.config(parsed.worldId), parsed, realNow);
  },
  faults: (value: z.input<typeof FaultsItem>, realNow: Date) => {
    const parsed = FaultsItem.parse(value);
    return rawItem(ENTITY.faults, parsed.worldId, keys.faults(parsed.worldId), parsed, realNow);
  },
  batch: (batch: z.input<typeof StoredBatch>, realNow: Date) => {
    const parsed = StoredBatch.parse(batch);
    return rawItem(ENTITY.batch, parsed.worldId, keys.batch(parsed.worldId, parsed.network, parsed.businessDate), parsed, realNow);
  },
  line: (value: z.input<typeof StoredLine>, realNow: Date) => {
    const parsed = StoredLine.parse(value);
    const { network, businessDate, operationCode } = parsed.line;
    return rawItem(ENTITY.line, parsed.worldId, keys.line(parsed.worldId, network, businessDate, operationCode), parsed, realNow);
  },
  /** The claim of a code carries its line, so a retried registration can be told from a reuse. */
  operationCode: (value: z.input<typeof StoredLine>, realNow: Date) => {
    const parsed = StoredLine.parse(value);
    return rawItem(ENTITY.operationCode, parsed.worldId, keys.operationCode(parsed.worldId, parsed.line.network, parsed.line.operationCode), parsed, realNow);
  },
  transfer: (value: z.input<typeof StoredTransfer>, realNow: Date) => {
    const parsed = StoredTransfer.parse(value);
    return rawItem(ENTITY.transfer, parsed.worldId, keys.transfer(parsed.worldId, parsed.transferId), parsed, realNow);
  },
  reversalClaim: (value: z.input<typeof ReversalClaim>, realNow: Date) => {
    const parsed = ReversalClaim.parse(value);
    return rawItem(ENTITY.reversalClaim, parsed.worldId, keys.reversalClaim(parsed.worldId, parsed.transferId), parsed, realNow);
  },
};

const STORAGE_ATTRIBUTES = new Set(["pk", "sk", "entity", "worldIndexKey", "worldIndexSort", "createdAt", "updatedAt", "expiresAt"]);

/** The entity's own fields of a raw item (the storage attributes dropped), parsed with its schema. */
export function fromRaw<T>(schema: z.ZodType<T>, raw: Record<string, unknown>): T {
  const fields = Object.fromEntries(Object.entries(raw).filter(([name]) => !STORAGE_ATTRIBUTES.has(name)));
  return schema.parse(fields);
}
