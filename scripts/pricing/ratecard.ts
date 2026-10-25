// Rate card and cost estimate (docs/build-plan.md WP-46). Run from the repository root:
//
//   tsx scripts/pricing/ratecard.ts            checks scripts/seed/data/ratecard.json against the verified
//                                              price lines and prints the card and the estimate (exit 1 on drift)
//   tsx scripts/pricing/ratecard.ts --write    writes scripts/seed/data/ratecard.json from the price lines
//   tsx scripts/pricing/ratecard.ts --live     re-reads the AWS Price List offer files and fails if a line changed
//
// Nothing here calls an AWS account: the offer files are public. A line that changed is updated in
// price-list.ts with the new date, then `--write`.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../seed/lib/json";
import { RATE_CARD_FILE, buildRateCard, rateCardDrift } from "./card";
import { estimate } from "./estimate";
import { checkLive } from "./live";
import { estimateLines, rateCardLines } from "./report";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The bytes `--write` puts in `ratecard.json`: the seed's canonical JSON. */
export function rateCardFileContent(): string {
  return stableStringify(buildRateCard());
}

function readCommitted(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const path = join(ROOT, RATE_CARD_FILE);
  if (argv.includes("--write")) {
    writeFileSync(path, rateCardFileContent());
    console.log(`ratecard: wrote ${RATE_CARD_FILE}`);
  }
  if (argv.includes("--live")) {
    const report = await checkLive();
    for (const [offer, at] of Object.entries(report.published)) console.log(`  ${offer} published ${at}`);
    if (report.problems.length > 0) {
      for (const problem of report.problems) console.error(`  ${problem}`);
      console.error("ratecard: the AWS Price List changed; update scripts/pricing/price-list.ts with the new date and run --write.");
      return 1;
    }
    console.log("ratecard: every price line still matches the AWS Price List.");
  }
  for (const line of rateCardLines(buildRateCard())) console.log(line);
  for (const line of estimateLines(estimate())) console.log(line);
  const drift = rateCardDrift(readCommitted(path));
  if (drift.length > 0) {
    for (const problem of drift) console.error(`  ${problem}`);
    console.error(`ratecard: ${RATE_CARD_FILE} does not carry the verified price lines (run with --write).`);
    return 1;
  }
  console.log(`ratecard: ${RATE_CARD_FILE} carries the verified price lines.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
