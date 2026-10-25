// The scenarios of docs/test-plan.md §4.5 and the two suites (§5): `smoke` is SC-00, what every deploy
// runs; `full` is every scenario that declares it (SC-00 to SC-22 and SC-24), SC-22 before SC-21 in one
// lane and SC-20 last. SC-23 (live WhatsApp, in a world approved for live) and the light load run only when named.
//
// Each scenario is a module `scripts/scenarios/sc-<nn>-<name>.ts` (or `load-light.ts`) whose default
// export is `defineScenario({...})`: the registry finds them on disk, so a scenario added by its own work
// package joins the suites without touching this file. Two modules with the same id are an error.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { ScenarioDef, Suite } from "./steps";

export const SCENARIO_DIR = fileURLToPath(new URL("..", import.meta.url));
const MODULE = /^(?:sc-\d{2}-[a-z0-9-]+|load-light)\.ts$/;

/** The scenario modules of the directory, in file order (`sc-00-…` first). */
export function scenarioFiles(names: readonly string[] = readdirSync(SCENARIO_DIR)): string[] {
  return names.filter((name) => MODULE.test(name)).sort();
}

function isScenario(value: unknown): value is ScenarioDef {
  const candidate = value as Partial<ScenarioDef> | undefined;
  return typeof candidate?.id === "string" && typeof candidate.slug === "string" && Array.isArray(candidate.steps) && Array.isArray(candidate.suites);
}

export async function loadScenarios(directory: string = SCENARIO_DIR, names?: readonly string[]): Promise<ScenarioDef[]> {
  const scenarios: ScenarioDef[] = [];
  for (const name of scenarioFiles(names ?? readdirSync(directory))) {
    const loaded = ((await import(pathToFileURL(join(directory, name)).href)) as { default?: unknown }).default;
    if (!isScenario(loaded)) throw new TypeError(`${name} has no default export from defineScenario()`);
    if (scenarios.some((scenario) => scenario.id === loaded.id)) throw new RangeError(`${name}: ${loaded.id} is defined twice`);
    scenarios.push(loaded);
  }
  return scenarios;
}

/** The scenarios of a suite, in order; the on-demand ones never join a suite. */
export function scenariosOf(all: readonly ScenarioDef[], suite: Suite): ScenarioDef[] {
  return all.filter((scenario) => !scenario.onDemand && scenario.suites.includes(suite));
}

/** Scenarios named with `--scenario SC-xx` (repeatable), in file order. */
export function namedScenarios(all: readonly ScenarioDef[], ids: readonly string[]): ScenarioDef[] {
  const unknown = ids.filter((id) => !all.some((scenario) => scenario.id === id));
  if (unknown.length > 0) throw new RangeError(`unknown scenario(s): ${unknown.join(", ")}`);
  return all.filter((scenario) => ids.includes(scenario.id));
}
