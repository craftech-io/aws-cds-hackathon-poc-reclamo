// `verify_register_chain` (docs/architecture.md §8.3, ADR-0014): walks one chain of a world and epoch,
// recomputes every hash and compares each entry with its anchors. The rules, the same here and in
// `scripts/register/verify.ts` (which verifies an exported file without access to the stage):
//
//   - anchors are ordered by `ingestionTime` (CloudWatch's), never by the client-chosen `timestamp`;
//   - the FIRST ingested anchor of a `seq` in the exact stream `<worldId>-e<epoch>-<chain>` is the
//     reference: a stored hash that differs from it breaks the chain at that `seq`;
//   - two anchors of the same `seq` that disagree are an `ANCHOR_CONFLICT`, a break even when the
//     first one matches the table (someone wrote a back-dated anchor);
//   - an anchor in any other stream is ignored and reported in `foreignAnchors[]`;
//   - a `seq` without an anchor goes to `unanchored[]` and the result is `partial`, never `ok`.
//
// So an overwrite with an unconditional `PutItem` (IAM cannot stop it) is detected in every anchored
// entry, even when the writer recomputed the hashes with the published key.
import type { ChainKind } from "../domain/ledger";
import { type AnchorEvent, type AnchorReader, AnchorRecord, anchorStreamName } from "./anchors";
import type { ComplaintsDeps } from "./deps";
import { GENESIS_HASH, type ChainEntryOf, chainHash } from "./register";

export type VerificationResult = "ok" | "partial" | "broken";

export type BreakReason = "SEQ_GAP" | "PREV_HASH_MISMATCH" | "HASH_MISMATCH" | "ANCHOR_MISMATCH" | "ANCHOR_CONFLICT" | "ENTRY_MISSING";

export interface ChainBreak {
  readonly seq: number;
  readonly reason: BreakReason;
}

export interface ForeignAnchor {
  readonly stream: string;
  readonly seq?: number;
  readonly ingestionTime: number;
}

export interface ChainVerification {
  readonly result: VerificationResult;
  readonly chain: ChainKind;
  readonly worldId: string;
  readonly epoch: number;
  /** Entries walked. */
  readonly entries: number;
  readonly headHash?: string;
  /** Lowest broken `seq`. */
  readonly brokenAt?: number;
  readonly breaks: readonly ChainBreak[];
  readonly anchorConflicts: readonly number[];
  readonly unanchored: readonly number[];
  readonly foreignAnchors: readonly ForeignAnchor[];
}

/** The minimal shape of an entry the verification needs (a stored entry or a row of an export). */
export type VerifiableEntry = Readonly<Record<string, unknown>> & { readonly seq: number; readonly prevHash: string; readonly hash: string };

export interface VerifyInput {
  readonly worldId: string;
  readonly epoch: number;
  readonly chain: ChainKind;
  /** The published `RegisterChainKey`. */
  readonly key: string;
  readonly entries: readonly VerifiableEntry[];
  /** Every anchor event of the world and epoch (any stream); the others chains' streams are skipped. */
  readonly anchors: readonly AnchorEvent[];
}

const CHAINS: readonly ChainKind[] = ["REG", "RRI", "TAPE"];

interface ParsedAnchor {
  readonly seq: number;
  readonly hash: string;
  readonly ingestionTime: number;
  readonly order: number;
}

function seqOfMessage(message: string): number | undefined {
  try {
    const seq: unknown = Reflect.get(JSON.parse(message) as object, "seq");
    return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
  } catch {
    return undefined;
  }
}

/** The anchors of this chain's exact stream, by `seq`, each list in ingestion order; the rest sorted out. */
function sortAnchors(input: VerifyInput): { bySeq: Map<number, ParsedAnchor[]>; foreign: ForeignAnchor[] } {
  const own = anchorStreamName(input.worldId, input.epoch, input.chain);
  const siblings = new Set(CHAINS.filter((chain) => chain !== input.chain).map((chain) => anchorStreamName(input.worldId, input.epoch, chain)));
  const bySeq = new Map<number, ParsedAnchor[]>();
  const foreign: ForeignAnchor[] = [];
  input.anchors.forEach((event, order) => {
    if (siblings.has(event.stream)) return;
    const parsed = AnchorRecord.safeParse(safeJson(event.message));
    const matches = parsed.success && parsed.data.worldId === input.worldId && parsed.data.epoch === input.epoch && parsed.data.chain === input.chain;
    if (event.stream !== own || !matches || !parsed.success) {
      const seq = seqOfMessage(event.message);
      foreign.push({ stream: event.stream, ingestionTime: event.ingestionTime, ...(seq !== undefined ? { seq } : {}) });
      return;
    }
    const list = bySeq.get(parsed.data.seq) ?? [];
    list.push({ seq: parsed.data.seq, hash: parsed.data.hash, ingestionTime: event.ingestionTime, order });
    bySeq.set(parsed.data.seq, list);
  });
  for (const list of bySeq.values()) list.sort((a, b) => a.ingestionTime - b.ingestionTime || a.order - b.order);
  return { bySeq, foreign };
}

function safeJson(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
}

/** Pure verification of one chain against its anchors (shared with scripts/register/verify.ts). */
export function verifyChain(input: VerifyInput): ChainVerification {
  const entries = [...input.entries].sort((a, b) => a.seq - b.seq);
  const breaks: ChainBreak[] = [];
  const { bySeq, foreign } = sortAnchors(input);
  const anchorConflicts: number[] = [];
  const unanchored: number[] = [];

  let previous = GENESIS_HASH;
  entries.forEach((entry, index) => {
    const expectedSeq = index + 1;
    if (entry.seq !== expectedSeq) breaks.push({ seq: Math.min(entry.seq, expectedSeq), reason: "SEQ_GAP" });
    else if (entry.prevHash !== previous) breaks.push({ seq: entry.seq, reason: "PREV_HASH_MISMATCH" });
    else if (chainHash(input.key, entry.prevHash, entry) !== entry.hash) breaks.push({ seq: entry.seq, reason: "HASH_MISMATCH" });
    previous = entry.hash;

    const anchors = bySeq.get(entry.seq);
    if (!anchors || anchors.length === 0) {
      unanchored.push(entry.seq);
      return;
    }
    const [first] = anchors;
    if (anchors.some((anchor) => anchor.hash !== first?.hash)) {
      anchorConflicts.push(entry.seq);
      breaks.push({ seq: entry.seq, reason: "ANCHOR_CONFLICT" });
    } else if (first?.hash !== entry.hash) {
      breaks.push({ seq: entry.seq, reason: "ANCHOR_MISMATCH" });
    }
  });

  // An anchored `seq` with no entry: the entry was removed or the chain was cut.
  const present = new Set(entries.map((entry) => entry.seq));
  for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) if (!present.has(seq)) breaks.push({ seq, reason: "ENTRY_MISSING" });

  const brokenAt = breaks.length > 0 ? Math.min(...breaks.map((item) => item.seq)) : undefined;
  const result: VerificationResult = brokenAt !== undefined ? "broken" : unanchored.length > 0 ? "partial" : "ok";
  const last = entries.at(-1);
  return {
    result,
    chain: input.chain,
    worldId: input.worldId,
    epoch: input.epoch,
    entries: entries.length,
    ...(last ? { headHash: last.hash } : {}),
    ...(brokenAt !== undefined ? { brokenAt } : {}),
    breaks: breaks.sort((a, b) => a.seq - b.seq),
    anchorConflicts,
    unanchored,
    foreignAnchors: foreign,
  };
}

/** Pages of a chain read at most (500 entries each). */
const MAX_PAGES = 200;

/** Every entry of one chain of a world and epoch, in `seq` order. */
export async function loadChain<C extends ChainKind>(deps: Pick<ComplaintsDeps, "connector">, worldId: string, epoch: number, chain: C): Promise<ChainEntryOf<C>[]> {
  const entries: ChainEntryOf<C>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const options = cursor ? { cursor } : {};
    const result =
      chain === "TAPE"
        ? await deps.connector.chains.listTapeBySeq(worldId, epoch, options)
        : await deps.connector.chains.listRegister(chain as "REG" | "RRI", worldId, epoch, options);
    entries.push(...(result.entries as ChainEntryOf<C>[]));
    cursor = result.cursor;
    if (!cursor) return entries;
  }
  throw new RangeError(`more than ${MAX_PAGES} pages in the ${chain} chain`);
}

export interface VerifyRegisterRequest {
  readonly worldId: string;
  readonly epoch: number;
  readonly chain: ChainKind;
}

/** Loads the chain and its anchors and verifies them; `broken` logs the `ChainBroken` metric line. */
export async function verifyRegisterChain(deps: Pick<ComplaintsDeps, "connector" | "chainKey" | "log">, reader: AnchorReader, request: VerifyRegisterRequest): Promise<ChainVerification> {
  const [entries, anchors] = await Promise.all([loadChain(deps, request.worldId, request.epoch, request.chain), reader.read(request.worldId, request.epoch)]);
  const verification = verifyChain({ ...request, key: deps.chainKey, entries: entries as unknown as VerifiableEntry[], anchors });
  const fields = {
    chain: request.chain,
    worldId: request.worldId,
    epoch: request.epoch,
    result: verification.result,
    entries: verification.entries,
    brokenAt: verification.brokenAt,
    anchorConflicts: verification.anchorConflicts.length,
    unanchored: verification.unanchored.length,
    foreignAnchors: verification.foreignAnchors.length,
  };
  if (verification.result === "broken") deps.log.error("register.chain_broken", { metric: "ChainBroken", ...fields });
  else deps.log.info("register.verified", fields);
  return verification;
}
