// The three evaluation sets of the seed (docs/seed-spec.md §12), parsed with zod before anything reads
// them: `evals/grounding.json` (EV-1), `evals/receipts.json` (EV-2) and `evals/classifier.json` (EV-3),
// plus the `models` template the eval worlds clone their customers from. Nothing here calls AWS.
//
// A receipt is read by `receipt.readProbe` from the `Seed` bucket, where seed:load puts the files of
// `media/receipts/…` under the same `receipts/…` key the set names. A persona's receipt
// (`receipts/<variant>/c<nn>-<seq>.png`) is addressed by `{variant, personaModel, seq}`; an eval-only
// image (`ev-…`) by its seed key (`file`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ComplaintType, ReconciliationResult } from "@reclamo/shared";
import { ReaderResult, ReceiptFields } from "../../packages/bff/src/receipts/schema";
import { ModelsDocument } from "../../packages/bff/src/qa-driver/world-models";

export const SEED_DATA_DIR = "scripts/seed/data";

export const GroundingEntry = z.object({
  id: z.string().regex(/^gnd-\d{2}$/),
  question: z.string().min(1).max(1_000),
  expectedClauseIds: z.array(z.string().min(1).max(40)).min(1),
  requiredFacts: z.array(z.string().min(1)).default([]),
  forbiddenPatterns: z.array(z.string().min(1)),
});
export type GroundingEntry = z.infer<typeof GroundingEntry>;

export const GroundingSet = z.object({
  version: z.string().min(1),
  threshold: z.object({ clauseRecall: z.number().min(0).max(1), forbidden: z.number().int().nonnegative(), groundingScore: z.number().min(0).max(1) }),
  entries: z.array(GroundingEntry).min(1),
});
export type GroundingSet = z.infer<typeof GroundingSet>;

export const ReceiptVariant = z.enum(["legible", "blurry", "fake-check", "fake-unknown", "injection", "not-receipt", "other-payer", "tampered-chunk"]);
export type ReceiptVariant = z.infer<typeof ReceiptVariant>;

export const ReceiptCase = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  file: z.string().regex(/^receipts\/[a-z-]+\/[a-z0-9-]+\.png$/),
  variant: ReceiptVariant,
  persona: z.string().regex(/^C\d{2}$/).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expected: z.object({
    result: ReaderResult,
    fields: ReceiptFields.optional(),
    reconciliation: ReconciliationResult.optional(),
    suspiciousText: z.boolean().optional(),
  }),
});
export type ReceiptCase = z.infer<typeof ReceiptCase>;

export const ReceiptSet = z.object({
  version: z.string().min(1),
  /** The 64 images of §9 (the eval-only ones and `C41`). */
  images: z.array(ReceiptCase).min(1),
  /** One receipt per persona that sends one (the full path reads these). */
  personas: z.array(ReceiptCase),
  /** "Comprobantes SR": what the scenarios send; 100 % exact in 5 repetitions before the full suite. */
  srSubset: z.array(ReceiptCase).min(1),
});
export type ReceiptSet = z.infer<typeof ReceiptSet>;

export const ClassifierKind = z.enum(["RECLAMO", "CONSULTA", "OUT_OF_SCOPE", "UNCLEAR"]);
export type ClassifierKind = z.infer<typeof ClassifierKind>;

export const ClassifierEntry = z.object({
  id: z.string().regex(/^cls-[a-z0-9-]{1,60}$/),
  text: z.string().min(1).max(1_000),
  expected: z.object({ kind: ClassifierKind, type: z.union([ComplaintType, z.literal("INFORMATION_REQUEST")]).optional() }),
});
export type ClassifierEntry = z.infer<typeof ClassifierEntry>;

export const ClassifierSet = z.object({ version: z.string().min(1), entries: z.array(ClassifierEntry).min(1) });
export type ClassifierSet = z.infer<typeof ClassifierSet>;

export interface EvalSets {
  readonly grounding: GroundingSet;
  readonly receipts: ReceiptSet;
  readonly classifier: ClassifierSet;
  readonly models: ModelsDocument;
}

function readJson(root: string, path: string): unknown {
  return JSON.parse(readFileSync(join(root, SEED_DATA_DIR, path), "utf8")) as unknown;
}

/** Reads and validates every set; a set that does not parse stops the run before any call. */
export function loadEvalSets(root: string = process.cwd()): EvalSets {
  return {
    grounding: GroundingSet.parse(readJson(root, "evals/grounding.json")),
    receipts: ReceiptSet.parse(readJson(root, "evals/receipts.json")),
    classifier: ClassifierSet.parse(readJson(root, "evals/classifier.json")),
    models: ModelsDocument.parse(readJson(root, "worlds/models.json")),
  };
}

/** What `receipt.readProbe` is asked for one case (besides the world). */
export type ProbeTarget = { readonly variant: string; readonly personaModel: string; readonly seq: number } | { readonly variant: string; readonly file: string };

const PERSONA_FILE = /^receipts\/([a-z-]+)\/c(\d{2})-(\d)\.png$/;

export function probeTargetOf(item: Pick<ReceiptCase, "file" | "variant">): ProbeTarget {
  const match = PERSONA_FILE.exec(item.file);
  if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) return { variant: match[1], personaModel: `C${match[2]}`, seq: Number(match[3]) };
  return { variant: item.variant, file: item.file };
}
