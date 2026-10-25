// `appendChained`: the only way an entry enters the complaint register (`REG#`), the refund register
// (`RRI#`) or the compliance tape (`TAPE#`) (docs/architecture.md §8.3, ADR-0014):
//
//   1. read the head `COUNTER#{REGSEQ|RRISEQ|TAPESEQ}#e<epoch>` = {value, hash}, strongly consistent;
//   2. `seq = value + 1`, `prevHash = hash` (the genesis hash for the first entry) and
//      `hash = HMAC-SHA256(RegisterChainKey, prevHash ‖ canonicalJson(entry without hash))`;
//   3. ONE `TransactWriteItems`: the head conditional on `value = seq − 1` (or absent), the entry's
//      `PutItem` with `attribute_not_exists(pk)` and the caller's items (a complaint transition, the
//      number counter, timers, an idempotency claim);
//   4. a cancelled transaction consumed nothing: re-read and retry (the caller's `build` runs again
//      and re-reads its own state), up to 5 times with jitter;
//   5. after the commit, ask `AnchorWriter` (asynchronous) to anchor the entry. A failed request is
//      logged and leaves the entry unanchored, which the verification reports as `partial`.
import type { z } from "zod";
import { type ChainHead, type ChainKind, RefundEntry, RegisterEntry, TapeEntry } from "../domain/ledger";
import type { AppendedEntry } from "../connector/repos/chains";
import { TransactionCancelledError } from "../connector/errors";
import type { WriteOp } from "../connector/store";
import { hmacSha256Hex } from "../lib/crypto";
import { withRetry } from "../lib/retry";
import { type ComplaintsDeps, OPTIMISTIC_ATTEMPTS, realNowOf } from "./deps";

/** `prevHash` of the first entry of every chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Stamps the connector adds; never part of the hashed content. */
const NOT_HASHED: ReadonlySet<string> = new Set(["hash", "createdAt", "updatedAt", "version"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, member]) => [key, canonical(member)]));
  }
  return value;
}

/** JSON with keys sorted at every level and `undefined` members dropped: one text per value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** The hashed content of an entry: every field but its own hash and the connector's stamps. */
export function hashedContent(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([name]) => !NOT_HASHED.has(name)));
}

/** `HMAC-SHA256(key, prevHash ‖ canonicalJson(entry without hash))` in lowercase hex. */
export function chainHash(key: string, prevHash: string, entry: Readonly<Record<string, unknown>>): string {
  return hmacSha256Hex(key, prevHash + canonicalJson(hashedContent(entry)));
}

export type ChainEntryOf<C extends ChainKind> = C extends "REG" ? RegisterEntry : C extends "RRI" ? RefundEntry : TapeEntry;
type ChainInputOf<C extends ChainKind> = C extends "REG" ? z.input<typeof RegisterEntry> : C extends "RRI" ? z.input<typeof RefundEntry> : z.input<typeof TapeEntry>;

/** What the caller writes: the entry without the fields the chain decides. `atReal` defaults to now. */
export type ChainBody<C extends ChainKind> = Omit<ChainInputOf<C>, "worldId" | "epoch" | "seq" | "prevHash" | "hash" | "atReal" | "createdAt" | "updatedAt"> & {
  readonly atReal?: string;
};

export interface BuildContext {
  /** 0 on the first try; a retry re-reads whatever the extras depend on. */
  readonly attempt: number;
  readonly head: ChainHead | undefined;
  readonly seq: number;
}

export interface ChainBuild<C extends ChainKind> {
  readonly entry: ChainBody<C>;
  /** Operations that commit with the entry or not at all. */
  readonly extra?: readonly WriteOp[];
}

export interface AppendChainedRequest<C extends ChainKind> {
  readonly chain: C;
  readonly worldId: string;
  readonly epoch: number;
  /** Runs on every attempt, after the head was read: re-read state, build the entry and the extras. */
  readonly build: (context: BuildContext) => Promise<ChainBuild<C>> | ChainBuild<C>;
}

export interface AppendChainedResult<C extends ChainKind> {
  readonly entry: ChainEntryOf<C>;
  readonly appended: AppendedEntry;
  /** Transactions tried (1 when nothing raced it). */
  readonly attempts: number;
}

const SCHEMAS = { REG: RegisterEntry, RRI: RefundEntry, TAPE: TapeEntry } as const;

/** A cancelled transaction (head moved, an extra's condition failed, a lost race): re-read and retry. */
export function isCancelled(error: unknown): boolean {
  return error instanceof TransactionCancelledError && error.code === "CONFLICT";
}

/** Appends one entry to a chain with the optimistic scheme of §8.3 and asks for its anchor. */
export async function appendChained<C extends ChainKind>(deps: ComplaintsDeps, request: AppendChainedRequest<C>): Promise<AppendChainedResult<C>> {
  const { connector } = deps;
  let tries = 0;
  const result = await withRetry(
    async (attempt) => {
      tries = attempt + 1;
      const head = await connector.chains.readHead(request.worldId, request.epoch, request.chain);
      const seq = (head?.value ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_HASH;
      const built = await request.build({ attempt, head, seq });
      const unhashed = { ...built.entry, atReal: built.entry.atReal ?? realNowOf(deps).toISOString(), worldId: request.worldId, epoch: request.epoch, seq, prevHash };
      // Parse before hashing, so the hash covers exactly the fields that are stored and read back.
      const parsed = (SCHEMAS[request.chain] as unknown as z.ZodType<ChainEntryOf<C>>).parse({ ...unhashed, hash: GENESIS_HASH });
      const entry = { ...parsed, hash: chainHash(deps.chainKey, prevHash, parsed as unknown as Record<string, unknown>) } as ChainEntryOf<C>;
      const appended = await connector.chains.append({ chain: request.chain, head, entry: entry as never, extra: built.extra ?? [] });
      return { entry, appended };
    },
    { attempts: OPTIMISTIC_ATTEMPTS, baseDelayMs: 20, maxDelayMs: 400, shouldRetry: isCancelled, ...deps.retry },
  );
  await requestAnchor(deps, result.appended);
  return { ...result, attempts: tries };
}

/** Asks `AnchorWriter` for the anchor of a committed entry; a failure leaves it `partial`, never throws. */
export async function requestAnchor(deps: Pick<ComplaintsDeps, "anchors" | "log">, appended: AppendedEntry): Promise<void> {
  try {
    await deps.anchors.request({ worldId: appended.worldId, epoch: appended.epoch, chain: appended.chain, entries: [{ seq: appended.seq, pk: appended.pk, sk: appended.sk }] });
  } catch (error) {
    deps.log.error("register.anchor_request_failed", { metric: "AnchorWriteFailed", chain: appended.chain, worldId: appended.worldId, seq: appended.seq, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}
