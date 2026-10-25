// Fixed parameters of the synthetic seed (docs/seed-spec.md): the seed of the generator, the world
// clock of the templates, the placeholders the world factory substitutes and where every artifact
// lives. Nothing here reads the machine clock: two runs on two machines write the same bytes.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT = "reclamo-en-regla";
export const GENERATOR_VERSION = "1.0.0";

/** Seed of every random stream (sfc32 forked by name, generate/rng.ts). */
export const SEED = 20261007;

/** The paused simulated instant every template starts at (docs/seed-spec.md §4). */
export const START_AT_SIM = "2026-10-07T10:10:00-03:00";
export const START_DATE = "2026-10-07";
/** First business day of the year the historical register starts at. */
export const HISTORY_FROM = "2026-01-05";

/** What the world factory substitutes (docs/seed-spec.md §4): nothing else changes per world. */
export const WORLD_PLACEHOLDER = "<worldId>";
export const EPOCH_PLACEHOLDER = "<epoch>";

/**
 * Key of the hash chains as the template carries them. On `poc` the world factory recomputes every
 * chain with `RegisterChainKey` (an `sst.Secret`) for the concrete world; this value only lets the
 * validator check that the template's chains are consistent (invariant 12).
 */
export const TEST_CHAIN_KEY = "seed-template-chain-key-v1";
/** `prevHash` of `seq = 1`. */
export const GENESIS_HASH = "0".repeat(64);

/** Key of the customer hashes of the template's tape (`customerRef`); recomputed per world like the chains. */
export const TEST_CUSTOMER_REF_KEY = "seed-template-customer-ref-v1";
/**
 * Key of `phoneHash`/`emailHash` as the template carries them. The world factory recomputes both (and
 * writes the `PHONE#` claims) with PhoneHashKey from `phoneE164` and `email`, which the template keeps
 * for that purpose only.
 */
export const TEST_PHONE_HASH_KEY = "seed-template-phone-hash-v1";

/** Personas of the `qa-min` template (docs/seed-spec.md §4). */
export const QA_MIN_PERSONAS = ["C01", "C02", "C03", "C07", "C08", "C09"] as const;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const SEED_ROOT = join(REPO_ROOT, "scripts", "seed");

export interface SeedPaths {
  readonly root: string;
  readonly data: string;
  readonly media: string;
  readonly receipts: string;
  readonly worlds: string;
  readonly settlements: string;
  readonly evals: string;
  readonly load: string;
  readonly reference: string;
  readonly manifest: string;
}

/** Where a seed is written: `scripts/seed` by default, or another root (the determinism test). */
export function seedPaths(root: string = SEED_ROOT): SeedPaths {
  const data = join(root, "data");
  const media = join(root, "media");
  return {
    root,
    data,
    media,
    receipts: join(media, "receipts"),
    worlds: join(data, "worlds"),
    settlements: join(data, "settlements"),
    evals: join(data, "evals"),
    load: join(data, "load"),
    reference: join(data, "reference.json"),
    manifest: join(data, "manifest.json"),
  };
}
