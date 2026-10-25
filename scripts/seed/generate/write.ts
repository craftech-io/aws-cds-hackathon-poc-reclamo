// Writes a seed bundle to disk (docs/seed-spec.md §1): canonical JSON (sorted keys), the world
// templates, the settlement CSVs of each template, the receipts, the evals, the load inputs, the
// reference data, the verified rate card (scripts/pricing/card.ts) and, last, the manifest with the
// SHA-256 of every file, the counts, the facts the flows quote and the result of the invariants run
// over what was written.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildRateCard } from "../../pricing/card";
import { GENERATOR_VERSION, PRODUCT, SEED, START_AT_SIM, type SeedPaths } from "../lib/constants";
import { sha256Hex, stableJsonLines, stableStringify } from "../lib/json";
import type { SeedBundle } from "./seed";
import { batchPath } from "./settlements";

function write(path: string, content: string | Uint8Array, files: Map<string, string>, root: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  writeFileSync(path, bytes);
  files.set(relative(root, path), sha256Hex(bytes));
}

/** Replaces `data/` and `media/` with the bundle (everything there is generated); returns file → SHA-256. */
export function writeSeed(bundle: SeedBundle, paths: SeedPaths): Map<string, string> {
  rmSync(paths.data, { recursive: true, force: true });
  rmSync(paths.media, { recursive: true, force: true });
  const files = new Map<string, string>();
  const put = (path: string, content: string | Uint8Array): void => write(path, content, files, paths.root);
  for (const [name, template] of Object.entries(bundle.templates)) put(join(paths.worlds, `${name}.json`), stableStringify(template));
  put(join(paths.worlds, "models.json"), stableStringify(bundle.models));
  for (const [name, batches] of Object.entries(bundle.batches)) {
    for (const batch of batches) if (batch.csv) put(join(paths.settlements, name, batchPath(batch.network, batch.businessDate)), batch.csv);
  }
  for (const receipt of bundle.receipts) put(join(paths.receipts, receipt.path), receipt.bytes);
  put(join(paths.evals, "grounding.json"), stableStringify(bundle.evals.grounding));
  put(join(paths.evals, "receipts.json"), stableStringify(bundle.evals.receipts));
  put(join(paths.evals, "classifier.json"), stableStringify(bundle.evals.classifier));
  put(join(paths.evals, "collection-corpus.json"), stableStringify(bundle.evals.collectionCorpus));
  put(join(paths.load, "simulated-complaints.jsonl"), stableJsonLines(bundle.load.simulated));
  put(join(paths.load, "batch-inputs.jsonl"), stableJsonLines(bundle.load.batch));
  put(paths.reference, stableStringify(bundle.reference));
  put(join(paths.data, "ratecard.json"), stableStringify(buildRateCard()));
  return files;
}

export interface ManifestInput {
  readonly files: ReadonlyMap<string, string>;
  readonly facts: Record<string, unknown>;
  readonly validation: { readonly errors: readonly string[] };
}

export function writeManifest(bundle: SeedBundle, input: ManifestInput, paths: SeedPaths): void {
  const counts: Record<string, unknown> = {};
  for (const [name, template] of Object.entries(bundle.templates)) counts[name] = template.counts;
  counts.models = Object.keys(bundle.models.personas).length;
  counts.receipts = bundle.receipts.length;
  const manifest = {
    product: PRODUCT,
    generatorVersion: GENERATOR_VERSION,
    seed: SEED,
    startAtSim: START_AT_SIM,
    files: Object.fromEntries([...input.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    counts,
    seedReceiptHashes: Object.fromEntries(bundle.receipts.map((receipt) => [`receipts/${receipt.path}`, receipt.sha256])),
    facts: input.facts,
    // Warnings depend on which modules of the tree exist (the real core, the policy): not recorded, so
    // the manifest only changes when the seed does.
    validation: { status: input.validation.errors.length === 0 ? "PASS" : "FAIL", invariants: 22, errors: [...input.validation.errors] },
  };
  writeFileSync(paths.manifest, stableStringify(manifest));
}
