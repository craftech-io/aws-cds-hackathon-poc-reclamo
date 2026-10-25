// `Reference/SeedReceiptHash` (docs/architecture.md §5-§6): the SHA-256 of every synthetic receipt the
// seed renders (`scripts/seed/data/manifest.json` → `seedReceiptHashes`), loaded by `seed:load`. A
// server-side copy of a seed receipt whose bytes hash to one of these does not wait for its malware
// scan (`SCAN_WAIT_SKIPPED_SEED`), and a seed `RECEIPT_IMAGE` is read only when its hash is here.
// Keyed by the hash itself: `REF#SEED_RECEIPT_HASH#SHA256` / `<sha256>`.
import { z } from "zod";
import type { Connector } from "../connector/port";

export const SEED_RECEIPT_HASH_REFERENCE = { type: "SEED_RECEIPT_HASH", scope: "SHA256" } as const;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const SeedReceiptHashRecord = z.object({ sha256: Sha256, seedKey: z.string().regex(/^receipts\/[a-z-]+\/[A-Za-z0-9._-]+\.(png|jpe?g)$/) });
export type SeedReceiptHashRecord = z.infer<typeof SeedReceiptHashRecord>;

/** Whether `sha256` is the hash of a receipt the seed rendered. */
export async function isSeedReceiptHash(data: Pick<Connector, "reference">, sha256: string): Promise<boolean> {
  if (!Sha256.safeParse(sha256).success) return false;
  const record = await data.reference.get(SeedReceiptHashRecord, SEED_RECEIPT_HASH_REFERENCE.type, SEED_RECEIPT_HASH_REFERENCE.scope, sha256);
  return record?.sha256 === sha256;
}
