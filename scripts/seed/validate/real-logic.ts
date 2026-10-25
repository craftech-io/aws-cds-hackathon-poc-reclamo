// The real decision modules invariants 8 to 11 run (docs/seed-spec.md §14): `evaluateCharge` and
// `findDuplicates` of the core mock (WP-15), `evaluateAsOf` and `isCollection` of channel-policy
// (WP-17). They are loaded at run time: while a module does not exist (or does not load), the
// invariant runs the contract's reference logic (reference-logic.ts) and the validator warns.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/constants";

export type Json = Record<string, unknown>;

export interface ChargeVerdict {
  readonly verdict: string;
  readonly reason: string;
  readonly expectedAmount: number;
}

export interface RealLogic {
  readonly evaluateCharge?: (facts: { charge: Json; loan?: Json; instalment?: Json; payments: Json[]; otherCharges: Json[] }) => ChargeVerdict;
  readonly findDuplicates?: (debits: Json[]) => Json[];
  readonly evaluateAsOf?: (facts: Json) => { decision: string; ruleIds: readonly string[] };
  readonly isCollection?: (text: string) => boolean;
  readonly parseCoreItem?: (entity: string, data: Json) => Json;
  readonly problems: string[];
}

const MODULES = {
  fees: "packages/core-mock/src/ledger/fees.ts",
  duplicates: "packages/core-mock/src/ledger/duplicates.ts",
  items: "packages/core-mock/src/store/items.ts",
  asOf: "packages/bff/src/channel-policy/as-of.ts",
  lexicon: "packages/bff/src/channel-policy/collection-lexicon.ts",
} as const;

async function load(path: string, problems: string[]): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(join(REPO_ROOT, path))) {
    problems.push(`${path} does not exist yet: the contract's reference logic runs instead`);
    return undefined;
  }
  try {
    return (await import(join(REPO_ROOT, path))) as Record<string, unknown>;
  } catch (error) {
    problems.push(`${path} does not load (${error instanceof Error ? error.message : String(error)}): the reference logic runs instead`);
    return undefined;
  }
}

function fn<T>(module: Record<string, unknown> | undefined, name: string, path: string, problems: string[]): T | undefined {
  if (!module) return undefined;
  const value = module[name];
  if (typeof value !== "function") {
    problems.push(`${path} has no ${name}(): the reference logic runs instead`);
    return undefined;
  }
  return value as T;
}

/** Loads whatever real logic exists in this tree. */
export async function loadRealLogic(): Promise<RealLogic> {
  const problems: string[] = [];
  const fees = await load(MODULES.fees, problems);
  const duplicates = await load(MODULES.duplicates, problems);
  const items = await load(MODULES.items, problems);
  const asOf = await load(MODULES.asOf, problems);
  const lexicon = await load(MODULES.lexicon, problems);
  const entities = items?.CUSTOMER_ENTITIES as Record<string, { parse: (value: unknown) => Json }> | undefined;
  const evaluateCharge = fn<RealLogic["evaluateCharge"]>(fees, "evaluateCharge", MODULES.fees, problems);
  const findDuplicates = fn<RealLogic["findDuplicates"]>(duplicates, "findDuplicates", MODULES.duplicates, problems);
  const evaluateAsOf = fn<RealLogic["evaluateAsOf"]>(asOf, "evaluateAsOf", MODULES.asOf, problems);
  const isCollection = fn<RealLogic["isCollection"]>(lexicon, "isCollection", MODULES.lexicon, problems);
  return {
    ...(evaluateCharge ? { evaluateCharge } : {}),
    ...(findDuplicates ? { findDuplicates } : {}),
    ...(evaluateAsOf ? { evaluateAsOf } : {}),
    ...(isCollection ? { isCollection } : {}),
    ...(entities
      ? {
          parseCoreItem: (entity: string, data: Json): Json => {
            const schema = entities[entity];
            if (!schema) throw new Error(`the core has no ${entity} schema`);
            return schema.parse({ entity, ...data });
          },
        }
      : {}),
    problems,
  };
}
