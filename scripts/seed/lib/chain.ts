// Hash chains of the template's append-only records (docs/architecture.md §8.3): register (`REG#`),
// refund register (`RRI#`) and tape (`TAPE#`). `hash = HMAC-SHA256(key, prevHash ‖ canonicalJson(entry
// without hash))`, `seq` from 1 without gaps, `prevHash` of `seq = 1` = GENESIS_HASH. The template's
// chains use TEST_CHAIN_KEY; the world factory recomputes them for each world with RegisterChainKey.
// The hash is the product's own (complaints/register.ts), so a seeded entry verifies like a live one.
import { chainHash as registerChainHash } from "@reclamo/bff/complaints/register";
import { GENESIS_HASH, TEST_CHAIN_KEY } from "./constants";

export interface Chained {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}

export function chainHash(prevHash: string, entryWithoutHash: Readonly<Record<string, unknown>>, key: string = TEST_CHAIN_KEY): string {
  return registerChainHash(key, prevHash, entryWithoutHash);
}

/** Chains `entries` in the given order (already sorted by the caller). */
export function chain<T extends Record<string, unknown>>(entries: readonly T[], key: string = TEST_CHAIN_KEY): Array<T & Chained> {
  let prevHash = GENESIS_HASH;
  return entries.map((entry, index) => {
    const unhashed = { ...entry, seq: index + 1, prevHash };
    const hash = chainHash(prevHash, unhashed, key);
    prevHash = hash;
    return { ...unhashed, hash };
  });
}

export interface ChainCheck {
  readonly ok: boolean;
  readonly brokenAt?: number;
  readonly head: { readonly value: number; readonly hash: string };
}

/** Recomputes a chain in `seq` order: gaps, a wrong `prevHash` or a wrong `hash` break it. */
export function verifyChain(entries: ReadonlyArray<Record<string, unknown>>, key: string = TEST_CHAIN_KEY): ChainCheck {
  const sorted = [...entries].sort((a, b) => Number(a.seq) - Number(b.seq));
  let prevHash = GENESIS_HASH;
  for (const [index, entry] of sorted.entries()) {
    const { hash, ...rest } = entry;
    if (entry.seq !== index + 1 || entry.prevHash !== prevHash || chainHash(prevHash, rest, key) !== hash) {
      return { ok: false, brokenAt: index + 1, head: { value: index, hash: prevHash } };
    }
    prevHash = String(hash);
  }
  return { ok: true, head: { value: sorted.length, hash: prevHash } };
}
