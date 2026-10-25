// Generates the synthetic seed (docs/seed-spec.md): the world templates, settlement files, receipts,
// evals, load inputs, reference data and the manifest. Deterministic (seed 20261007, no Intl, no
// machine clock, canonical JSON, PNGs compressed by the bundled pure-JS deflate at a fixed level):
// two runs in separate processes write the same bytes. The invariants of §14 run over what was
// written and their result goes into the manifest; a failing invariant exits with 1.
//
//   npm run seed:generate                 writes scripts/seed/{data,media}
//   tsx scripts/seed/generate.ts --out D  writes D/{data,media} (the determinism test)
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedPaths } from "./lib/constants";
import { manifestFacts } from "./generate/facts";
import { buildSeed } from "./generate/seed";
import { writeManifest, writeSeed } from "./generate/write";
import { validateSeed } from "./validate/run";

export async function generate(root?: string): Promise<{ errors: readonly string[]; warnings: readonly string[] }> {
  const paths = seedPaths(root);
  const bundle = buildSeed();
  const files = writeSeed(bundle, paths);
  const facts = manifestFacts(bundle.ledger, bundle.qaLedger, bundle.receipts, bundle.templates["qa-min"]);
  // The forbidden-terms list is an external secret: `seed:validate` and `lint:forbidden` check it, the
  // manifest records only what does not depend on the machine.
  writeManifest(bundle, { files, facts, validation: { errors: [] } }, paths);
  const result = await validateSeed({ root: paths.root, forbiddenTerms: false });
  writeManifest(bundle, { files, facts, validation: result }, paths);
  return result;
}

function outArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--out");
  return index === -1 ? undefined : resolve(argv[index + 1] ?? ".");
}

async function main(): Promise<void> {
  const result = await generate(outArg(process.argv.slice(2)));
  for (const warning of result.warnings) console.warn(`seed:generate warning: ${warning}`);
  if (result.errors.length > 0) {
    console.error(`seed:generate: ${result.errors.length} invariant(s) failed:`);
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("seed:generate: seed written and valid.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
