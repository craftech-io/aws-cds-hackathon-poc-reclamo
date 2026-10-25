// The scenarios against the traceability matrix of docs/test-plan.md §2.2: every `SR` or `SMK` cell that
// cites a step of SC-00 to SC-24 (`SC-03/10`, `SMK/8`) names a step of the scenario that declares the
// flow, and every flow a step declares is one the matrix cites for that very step. `flows:check` only
// looks for the flow somewhere in the file; this pins it to the step number. A model persona is cloned
// once per world (the driver answers DUPLICATE_MODEL): no world of a scenario asks for one twice.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIO_DIR, loadScenarios, scenarioFiles } from "./suites";

const TEST_PLAN = readFileSync(fileURLToPath(new URL("../../../docs/test-plan.md", import.meta.url)), "utf8");
const OWN = /^(?:SC-\d{2}|SMK)\/\d+$/;

/** `SC-03/10` → the flows the matrix cites it for (SMK/n is SC-00's step n). */
function matrixCitations(): Map<string, Set<string>> {
  const cited = new Map<string, Set<string>>();
  for (const line of TEST_PLAN.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const flow = cells[1];
    if (flow === undefined || !/^FL-\d{3}$/.test(flow)) continue;
    for (const cell of [cells[6], cells[7]]) {
      for (const match of (cell ?? "").matchAll(/`([^`]+)`/g)) {
        const step = match[1] ?? "";
        if (!OWN.test(step)) continue;
        const key = step.replace(/^SMK\//, "SC-00/");
        cited.set(key, new Set([...(cited.get(key) ?? []), flow]));
      }
    }
  }
  return cited;
}

describe("scenarios SC-00 to SC-24 against the matrix of docs/test-plan.md §2.2", async () => {
  const scenarios = (await loadScenarios()).filter((scenario) => /^SC-\d{2}$/.test(scenario.id));
  const cited = matrixCitations();

  it("loads the twenty-five scenarios, one module each, SC-00 in the smoke suite", () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual(Array.from({ length: 25 }, (_value, n) => `SC-${String(n).padStart(2, "0")}`));
    expect(scenarios.filter((scenario) => scenario.suites.includes("smoke")).map((scenario) => scenario.id)).toEqual(["SC-00"]);
    expect(scenarioFiles(["sc-00-smoke.ts", "sc-12-agent-limits.ts", "load-light.ts", "run.ts", "sc-01-main-story.test.ts", "notes.md"])).toEqual(["load-light.ts", "sc-00-smoke.ts", "sc-12-agent-limits.ts"]);
  });

  it("every step the matrix cites exists and declares the flow", () => {
    expect(cited.size).toBeGreaterThan(60);
    const missing: string[] = [];
    for (const [step, flows] of cited) {
      const [id, n] = step.split("/");
      const def = scenarios.find((scenario) => scenario.id === id)?.steps.find((candidate) => String(candidate.n) === n);
      for (const flow of flows) if (!def?.flows.includes(flow)) missing.push(`${step} ${flow}`);
    }
    expect(missing).toEqual([]);
  });

  it("every flow a step declares is cited by the matrix for that step", () => {
    const extra: string[] = [];
    // SC-23 (on demand, in a world approved for live WhatsApp) is the matrix's exception §2.1: cited in its notes, not in a test column.
    for (const scenario of scenarios.filter((candidate) => candidate.onDemand !== true)) {
      for (const step of scenario.steps) for (const flow of step.flows) if (!cited.get(`${scenario.id}/${step.n}`)?.has(flow)) extra.push(`${scenario.id}/${step.n} ${flow}`);
    }
    expect(extra).toEqual([]);
  });

  it("no world clones a model twice", () => {
    const twice: string[] = [];
    for (const name of scenarioFiles()) {
      const source = readFileSync(`${SCENARIO_DIR}/${name}`, "utf8");
      for (const list of source.matchAll(/personas: \[([^\]]*)\]|const PERSONAS = \[([^\]]*)\]/g)) {
        const models = [...(list[1] ?? list[2] ?? "").matchAll(/model: "(C\d{2})"/g)].map((match) => match[1]);
        for (const model of new Set(models)) if (models.filter((other) => other === model).length > 1) twice.push(`${name} ${model}`);
      }
    }
    expect(twice).toEqual([]);
  });

  it("the setup steps (n = 0) declare no flow, and SC-00 keeps the order of the smoke", () => {
    for (const scenario of scenarios) for (const step of scenario.steps.filter((candidate) => candidate.n === 0)) expect(step.flows).toEqual([]);
    expect(scenarios[0]?.steps.map((step) => step.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
