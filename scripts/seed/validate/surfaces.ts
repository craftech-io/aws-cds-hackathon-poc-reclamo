// Invariant 16 (docs/seed-spec.md §14, ADR-0010, ADR-0019): no term of the external list in any
// artifact of the seed (text and PNG text chunks), and no contest word on what a user sees. The list
// lives outside the repository (`FORBIDDEN_TERMS`); with `CI=true` and no list the check fails closed,
// and the output never prints a term, only where it was found and its position in the list.
import { findTerms, listFromEnv, pngText } from "../../lint/forbidden-terms";
import { findNeutralTerms } from "../../lint/neutral-surfaces";
import type { SeedOnDisk } from "./read";

type Report = (invariant: number, message: string) => void;

function textOf(path: string, bytes: Buffer): string {
  return path.endsWith(".png") ? pngText(bytes) : bytes.toString("utf8");
}

export function checkSurfaces(seed: SeedOnDisk, report: Report, warn: (message: string) => void, options: { forbiddenTerms: boolean }): void {
  for (const [path, bytes] of seed.files) {
    for (const finding of findNeutralTerms(path, textOf(path, bytes))) report(16, `${finding.source}:${finding.line} names the contest ("${finding.term}")`);
  }
  if (!options.forbiddenTerms) return;
  const list = listFromEnv(process.env);
  if (!list.ok) {
    if (list.fatal) report(16, list.message);
    else warn(`forbidden terms not checked: ${list.message}`);
    return;
  }
  for (const [path, bytes] of seed.files) {
    for (const finding of findTerms(path, textOf(path, bytes), list.terms)) report(16, `${finding.source}:${finding.line} contains forbidden term #${finding.term}`);
  }
}
