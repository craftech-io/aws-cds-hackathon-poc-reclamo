// Runs the 22 invariants of docs/seed-spec.md §14 over a seed on disk and returns every problem,
// each prefixed with its invariant number, plus warnings (what could not be checked on this machine
// or still runs against a contract instead of the real module).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/constants";
import { checkBooks } from "./books";
import { checkPersonasAndArtifacts } from "./personas";
import { checkPolicy } from "./policy";
import { loadRealLogic } from "./real-logic";
import { type SeedOnDisk, readSeed } from "./read";
import { checkRegister } from "./register";
import { checkSurfaces } from "./surfaces";
import { checkTour } from "./tour";

export interface ValidateOptions {
  readonly root?: string;
  /** Check the external forbidden-terms list (`FORBIDDEN_TERMS`; fails closed with `CI=true`). */
  readonly forbiddenTerms?: boolean;
}

export interface ValidationResult {
  readonly errors: string[];
  readonly warnings: string[];
}

/** Every invariant over a seed already read (the tests mutate a read seed and call this). */
export async function validateLoaded(seed: SeedOnDisk, options: Omit<ValidateOptions, "root"> = {}): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const report = (invariant: number, message: string): void => {
    errors.push(`invariant ${invariant}: ${message}`);
  };
  const warn = (message: string): void => {
    warnings.push(message);
  };
  checkBooks(seed, report);
  const real = await loadRealLogic();
  for (const problem of real.problems) warn(`invariants 8-11: ${problem}`);
  checkPolicy(seed, real, report);
  checkRegister(seed, report);
  checkPersonasAndArtifacts(seed, report);
  checkTour(seed, report, warn);
  checkSurfaces(seed, report, warn, { forbiddenTerms: options.forbiddenTerms ?? true });
  if (!existsSync(join(REPO_ROOT, "packages/bff/src/intake/classifier.ts"))) warn("invariant 14: packages/bff/src/intake/classifier.ts does not exist yet; every complaint script is checked to name its type (its rule is asserted by intake/classifier.test.ts)");
  if (!existsSync(join(REPO_ROOT, "packages/bff/src/metrics/kpis.ts"))) warn("invariant 17: packages/bff/src/metrics/kpis.ts does not exist yet; the box is computed by scripts/seed/lib/kpis.ts");
  return { errors, warnings };
}

export async function validateSeed(options: ValidateOptions = {}): Promise<ValidationResult> {
  let seed: SeedOnDisk;
  try {
    seed = readSeed(options.root);
  } catch (error) {
    return { errors: [`the seed cannot be read: ${error instanceof Error ? error.message : String(error)}`], warnings: [] };
  }
  return validateLoaded(seed, options);
}
