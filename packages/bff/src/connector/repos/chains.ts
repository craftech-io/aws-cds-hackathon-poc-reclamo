// The three hash chains of a world and epoch: the complaint register (`REG#`), the refund register
// (`RRI#`) and the compliance tape (`TAPE#`). The storage half of `appendChained`
// (complaints/register.ts, docs/architecture.md §8.3):
//
//   1. `readHead` — `COUNTER#{REGSEQ|RRISEQ|TAPESEQ}#e<epoch>` = {value, hash}, strongly consistent.
//   2. the caller computes `seq = value + 1`, `prevHash = hash` and the entry's HMAC.
//   3. `append` — ONE `TransactWriteItems`: the head `SET value = :n, hash = :h` conditional on
//      `value = :n − 1` (or `attribute_not_exists` for `seq = 1`), the entry's `PutItem` with
//      `attribute_not_exists(pk)`, and the caller's extra operations (the complaint's transition).
//   4. a `TransactionCancelledError` means the head moved or an extra's condition failed: nothing
//      was written and no `seq` was consumed; the caller re-reads the head and retries.
//
// The entry tables receive only that `PutItem` (store.ts `assertAppendOnly`); the heads live in
// `Runtime`, which is mutable.
import type { z } from "zod";
import { ConnectorError } from "@reclamo/shared";
import { ChainHead, type ChainKind, RefundEntry, RegisterEntry, TapeEntry } from "../../domain/ledger";
import { localDateAr } from "../../services/business-days";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys, sortInstant, worldKey } from "../keys";
import { type Key, type StoredItem, type WriteOp, cond } from "../store";
import type { TableName } from "../tables";
import { expiry } from "../ttl";

const RUNTIME = "Runtime" as const;
const HEAD_NAME: Readonly<Record<ChainKind, string>> = { REG: "REGSEQ", RRI: "RRISEQ", TAPE: "TAPESEQ" };

type EntryOf<C extends ChainKind> = C extends "REG" ? RegisterEntry : C extends "RRI" ? RefundEntry : TapeEntry;
type NewEntryOf<C extends ChainKind> = C extends "REG" ? NewOf<typeof RegisterEntry> : C extends "RRI" ? NewOf<typeof RefundEntry> : NewOf<typeof TapeEntry>;

export interface AppendRequest<C extends ChainKind> {
  readonly chain: C;
  /** The head the caller read (`undefined` for an empty chain). */
  readonly head: ChainHead | undefined;
  readonly entry: NewEntryOf<C>;
  /** Operations that must commit with the entry (a complaint transition, the number counter, timers). */
  readonly extra?: readonly WriteOp[];
}

/** What `AnchorWriter` needs to re-read the committed entry (docs/architecture.md §8.3 step 5). */
export interface AppendedEntry {
  readonly chain: ChainKind;
  readonly worldId: string;
  readonly epoch: number;
  readonly seq: number;
  readonly pk: string;
  readonly sk: string;
  readonly hash: string;
}

const TABLE_OF: Readonly<Record<ChainKind, TableName>> = { REG: "Register", RRI: "Register", TAPE: "ComplianceTape" };

const SCHEMAS: { readonly [C in ChainKind]: z.ZodType<EntryOf<C>> } = { REG: RegisterEntry, RRI: RefundEntry, TAPE: TapeEntry };

export function chainsRepo(ctx: RepoContext) {
  const headKey = (worldId: string, epoch: number, chain: ChainKind): Key => keys.counter(worldId, HEAD_NAME[chain], keys.epochPart(epoch));

  const entryKey = (chain: ChainKind, entry: RegisterEntry | RefundEntry | TapeEntry): Key => {
    if (chain === "REG") return keys.register(entry.worldId, entry.epoch, entry.seq);
    if (chain === "RRI") return keys.refund(entry.worldId, entry.epoch, entry.seq);
    const tape = entry as TapeEntry;
    return keys.tape(tape.worldId, localDateAr(new Date(tape.atSim)), tape.atSim, tape.tapeId);
  };

  const entryIndexes = (chain: ChainKind, entry: RegisterEntry | RefundEntry | TapeEntry): Record<string, string | undefined> => {
    if (chain === "REG") return { complaintKey: worldKey(entry.worldId, keys.epochPart(entry.epoch), (entry as RegisterEntry).complaintNumber) };
    if (chain === "RRI") {
      const number = (entry as RefundEntry).complaintNumber;
      return number ? { complaintKey: worldKey(entry.worldId, keys.epochPart(entry.epoch), number) } : {};
    }
    const tape = entry as TapeEntry;
    return {
      atSort: sortInstant(tape.atSim),
      complaintKey: tape.complaintId ? worldKey(tape.worldId, "CMP", tape.complaintId) : undefined,
      decisionKey: worldKey(tape.worldId, tape.decision),
      seqKey: worldKey(tape.worldId, "TAPESEQ", keys.epochPart(tape.epoch)),
    };
  };

  /** The operations of one append: the conditional head update and the entry's put. */
  const appendOps = <C extends ChainKind>(request: AppendRequest<C>): { ops: WriteOp[]; appended: AppendedEntry } => {
    const entry: EntryOf<C> = validInput(SCHEMAS[request.chain], request.entry, TABLE_OF[request.chain]);
    const previous = request.head?.value ?? 0;
    if (entry.seq !== previous + 1) throw new ConnectorError("VALIDATION", `seq ${entry.seq} does not follow the head ${previous}`, TABLE_OF[request.chain]);
    if (request.head && entry.prevHash !== request.head.hash) throw new ConnectorError("VALIDATION", "prevHash is not the head's hash", TABLE_OF[request.chain]);
    const key = entryKey(request.chain, entry);
    const now = ctx.now();
    const head: WriteOp = {
      kind: "update",
      table: RUNTIME,
      key: headKey(entry.worldId, entry.epoch, request.chain),
      condition: previous === 0 ? cond.notExists("value") : cond.eq("value", previous),
      update: { set: { value: entry.seq, hash: entry.hash, entity: "ChainHead", worldId: entry.worldId, updatedAt: now.toISOString(), ...expiry("worldRuntime", entry.worldId, now) } },
    };
    const put: WriteOp = {
      kind: "put",
      table: TABLE_OF[request.chain],
      item: encode(entry, {
        entity: request.chain === "REG" ? "RegisterEntry" : request.chain === "RRI" ? "RefundEntry" : "TapeEntry",
        key,
        worldId: entry.worldId,
        retention: "register",
        now,
        indexes: entryIndexes(request.chain, entry),
      }),
      condition: cond.absent(),
    };
    return { ops: [head, put], appended: { chain: request.chain, worldId: entry.worldId, epoch: entry.epoch, seq: entry.seq, pk: key.pk, sk: key.sk, hash: entry.hash } };
  };

  const decodeEntries = <C extends ChainKind>(chain: C, items: readonly StoredItem[]): EntryOf<C>[] =>
    items.map((item) => decode(SCHEMAS[chain], item, TABLE_OF[chain]));

  const partitionOf = (chain: "REG" | "RRI", worldId: string, epoch: number): string =>
    worldKey(worldId, chain, keys.epochPart(epoch));

  return {
    /** Step 1: the head, strongly consistent. */
    async readHead(worldId: string, epoch: number, chain: ChainKind): Promise<ChainHead | undefined> {
      const item = await ctx.store.get(RUNTIME, headKey(worldId, epoch, chain), { consistent: true });
      return decodeOptional(ChainHead, item, RUNTIME);
    },

    appendOps,

    /** Step 3: head, entry and extras in one transaction; returns what `AnchorWriter` needs. */
    async append<C extends ChainKind>(request: AppendRequest<C>): Promise<AppendedEntry> {
      const { ops, appended } = appendOps(request);
      await ctx.store.transact([...ops, ...(request.extra ?? [])]);
      return appended;
    },

    /** One committed entry by its key, strongly consistent (`AnchorWriter` re-reads before anchoring). */
    async getEntry<C extends ChainKind>(chain: C, key: Key): Promise<EntryOf<C> | undefined> {
      const item = await ctx.store.get(TABLE_OF[chain], key, { consistent: true });
      return item ? decodeEntries(chain, [item])[0] : undefined;
    },

    /** The register (or refund register) of an epoch in `seq` order, from `fromSeq` on. */
    async listRegister<C extends "REG" | "RRI">(chain: C, worldId: string, epoch: number, options: { fromSeq?: number; limit?: number; cursor?: string } = {}) {
      const page = await ctx.store.query({
        table: "Register",
        partition: partitionOf(chain, worldId, epoch),
        ...(options.fromSeq ? { sort: { op: "ge" as const, value: keys.register(worldId, epoch, options.fromSeq).sk } } : {}),
        limit: options.limit ?? 500,
        consistent: true,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      return { entries: decodeEntries(chain, page.items), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    /** Every entry of a complaint in an epoch, in `seq` order (index `ByComplaint`). */
    async listRegisterByComplaint(worldId: string, epoch: number, complaintNumber: string): Promise<RegisterEntry[]> {
      const items = await queryAll(ctx.store, { table: "Register", index: "ByComplaint", partition: worldKey(worldId, keys.epochPart(epoch), complaintNumber) });
      return decodeEntries("REG", items.filter((item) => item.entity === "RegisterEntry"));
    },

    /** The tape of one simulated day (Argentine date), in time order. */
    async listTapeDay(worldId: string, day: string, options: { limit?: number; cursor?: string } = {}) {
      const page = await ctx.store.query({ table: "ComplianceTape", partition: keys.tapeDay(worldId, day), limit: options.limit ?? 200, ...(options.cursor ? { cursor: options.cursor } : {}) });
      return { entries: decodeEntries("TAPE", page.items), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    /** The tape of an epoch in `seq` order (index `BySeq`): what the chain verification walks. */
    async listTapeBySeq(worldId: string, epoch: number, options: { fromSeq?: number; limit?: number; cursor?: string } = {}) {
      const page = await ctx.store.query({
        table: "ComplianceTape",
        index: "BySeq",
        partition: worldKey(worldId, "TAPESEQ", keys.epochPart(epoch)),
        ...(options.fromSeq ? { sort: { op: "ge" as const, value: options.fromSeq } } : {}),
        limit: options.limit ?? 500,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      return { entries: decodeEntries("TAPE", page.items), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    /** Decisions about one complaint, newest first (index `ByComplaint`). */
    async listTapeByComplaint(worldId: string, complaintId: string, limit = 200): Promise<TapeEntry[]> {
      const page = await ctx.store.query({ table: "ComplianceTape", index: "ByComplaint", partition: worldKey(worldId, "CMP", complaintId), descending: true, limit });
      return decodeEntries("TAPE", page.items);
    },

    /** Entries with one decision (`BLOCKED`, …), newest first (index `ByDecision`). */
    async listTapeByDecision(worldId: string, decision: TapeEntry["decision"], limit = 200): Promise<TapeEntry[]> {
      const page = await ctx.store.query({ table: "ComplianceTape", index: "ByDecision", partition: worldKey(worldId, decision), descending: true, limit });
      return decodeEntries("TAPE", page.items);
    },

    /** The entries of one message (`ALLOWED` and `DISPATCH`), for `PolicyAudit` (index `ByMessage`). */
    async listTapeByMessage(messageId: string): Promise<TapeEntry[]> {
      return decodeEntries("TAPE", await queryAll(ctx.store, { table: "ComplianceTape", index: "ByMessage", partition: messageId }));
    },
  };
}

export type ChainsRepo = ReturnType<typeof chainsRepo>;
