// The append-only part of a world (docs/architecture.md §8.3 and §10): the register, the refund register
// and the tape of the template, rebuilt for THIS world with `RegisterChainKey`, and its audit entries.
//
//   - every entry is hashed exactly like `appendChained` (parsed with its schema, then
//     `HMAC(key, prevHash ‖ canonicalJson(entry))`), so a seeded entry verifies like a live one;
//   - every entry goes in with the chain's own transaction (head + `PutItem attribute_not_exists`),
//     never a batch: IAM denies `BatchWriteItem` on these tables;
//   - a retried block skips what the head already covers; an entry that exists with the same hash is
//     skipped, with another hash the build stops (`FACTORY_CONFLICT`);
//   - after each block `AnchorWriter` is asked to anchor what was appended (100 entries per request).
import type { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { GENESIS_HASH, canonicalJson, chainHash, hashedContent, isCancelled } from "../complaints/register";
import { MAX_ANCHOR_ENTRIES } from "../complaints/anchors";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import type { AppendedEntry } from "../connector/repos/chains";
import { AuditEntry, type ChainHead, RefundEntry, RegisterEntry, TapeEntry } from "../domain/ledger";
import type { WorldsDeps } from "./deps";
import type { ChainName, WorldBuild } from "./instantiate";

const SCHEMAS: Readonly<Record<ChainName, z.ZodType<RegisterEntry | RefundEntry | TapeEntry>>> = { REG: RegisterEntry, RRI: RefundEntry, TAPE: TapeEntry };

type Entry = RegisterEntry | RefundEntry | TapeEntry;

export function factoryConflict(message: string): ToolError {
  return new ToolError("CONFLICT", message, "FACTORY_CONFLICT");
}

const hashed = new WeakMap<WorldBuild, Map<ChainName, Entry[]>>();

/** The chain of the build with its `seq`, `prevHash` and `hash` for this world (computed once per build). */
export function hashedChain(build: WorldBuild, chain: ChainName, chainKey: string): Entry[] {
  let byChain = hashed.get(build);
  if (!byChain) {
    byChain = new Map();
    hashed.set(build, byChain);
  }
  const cached = byChain.get(chain);
  if (cached) return cached;
  let prevHash = GENESIS_HASH;
  const entries = build.chains[chain].map((raw, index) => {
    const unhashed = { ...raw, worldId: build.worldId, epoch: build.epoch, seq: index + 1, prevHash };
    const parsed = SCHEMAS[chain].parse({ ...unhashed, hash: GENESIS_HASH });
    const entry = { ...parsed, hash: chainHash(chainKey, prevHash, parsed as unknown as Record<string, unknown>) } as Entry;
    prevHash = entry.hash;
    return entry;
  });
  byChain.set(chain, entries);
  return entries;
}

async function anchorAll(deps: Pick<WorldsDeps, "anchors" | "log">, appended: readonly AppendedEntry[]): Promise<void> {
  const [first] = appended;
  if (!first) return;
  for (let start = 0; start < appended.length; start += MAX_ANCHOR_ENTRIES) {
    const slice = appended.slice(start, start + MAX_ANCHOR_ENTRIES);
    try {
      await deps.anchors.request({ worldId: first.worldId, epoch: first.epoch, chain: first.chain, entries: slice.map(({ seq, pk, sk }) => ({ seq, pk, sk })) });
    } catch (error) {
      // Same contract as a live append (complaints/register.ts): the entries stay unanchored
      // (`partial` in the verification) and the build goes on.
      deps.log.error("worlds.anchor_request_failed", { metric: "AnchorWriteFailed", chain: first.chain, worldId: first.worldId, entries: slice.length, errorName: error instanceof Error ? error.name : "UnknownError" });
    }
  }
}

function sameHead(head: ChainHead | undefined, entries: readonly Entry[]): boolean {
  if (!head || head.value === 0) return true;
  return entries[head.value - 1]?.hash === head.hash;
}

/** Appends entries `[from, to)` of a chain (indexes into the hashed chain), skipping what is already there. */
export async function appendChainBlock(deps: Pick<WorldsDeps, "connector" | "anchors" | "log">, build: WorldBuild, chain: ChainName, chainKey: string, from: number, to: number): Promise<void> {
  const entries = hashedChain(build, chain, chainKey);
  let head = await deps.connector.chains.readHead(build.worldId, build.epoch, chain);
  if (!sameHead(head, entries)) throw factoryConflict(`${chain} of ${build.worldId} e${build.epoch} has a head the template does not produce`);
  const appended: AppendedEntry[] = [];
  for (let index = from; index < Math.min(to, entries.length); index += 1) {
    const entry = entries[index] as Entry;
    if (head && head.value >= entry.seq) continue;
    try {
      appended.push(await deps.connector.chains.append({ chain, head, entry: entry as never }));
      head = { value: entry.seq, hash: entry.hash };
    } catch (error) {
      if (!isCancelled(error)) throw error;
      // Someone (an earlier run of this build) wrote it: equal hash → skip, anything else → stop.
      head = await deps.connector.chains.readHead(build.worldId, build.epoch, chain);
      if (!sameHead(head, entries) || (head?.value ?? 0) < entry.seq) throw factoryConflict(`${chain} entry ${entry.seq} of ${build.worldId} differs from the template`);
    }
  }
  await anchorAll(deps, appended);
}

function auditKey(entry: AuditEntry) {
  return keys.audit(entry.worldId, entry.epoch, entry.ts, entry.auditId);
}

/** Appends audit entries `[from, to)`; an existing entry with other content stops the build. */
export async function appendAuditBlock(deps: Pick<WorldsDeps, "connector" | "store">, build: WorldBuild, from: number, to: number): Promise<void> {
  for (const raw of build.audit.slice(from, to)) {
    const entry = AuditEntry.parse({ ...raw, worldId: build.worldId, epoch: build.epoch });
    try {
      await deps.connector.audit.append(entry);
    } catch (error) {
      if (!isConflict(error)) throw error;
      const stored = await deps.store.get("AuditLog", auditKey(entry), { consistent: true });
      const storedEntry = stored ? AuditEntry.safeParse(stripStorage(stored)) : undefined;
      if (!storedEntry?.success || canonicalJson(hashedContent(storedEntry.data)) !== canonicalJson(hashedContent(entry))) {
        throw factoryConflict(`audit entry ${entry.auditId} of ${build.worldId} differs from the template`);
      }
    }
  }
}

const STORAGE = new Set(["pk", "sk", "entity", "expiresAt", "actionKey", "refIndexKey"]);

function stripStorage(item: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([name]) => !STORAGE.has(name)));
}
