// The load files of docs/seed-spec.md §13 and the batch `batch.run` creates: 300 simulated presentations,
// 30 for the real agent, 3 per type, every line validated.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BATCH_PER_TYPE, BATCH_SIZE, batchPlan, parseLoadInputs } from "./inputs";

const LOAD = new URL("../../../../scripts/seed/data/load/", import.meta.url);
const read = (name: string) => parseLoadInputs(readFileSync(new URL(name, LOAD), "utf8"));

describe("metrics: load inputs [FL-098]", () => {
  it("[FL-098] parses the seed's 300 simulated and 30 batch presentations", () => {
    expect(read("simulated-complaints.jsonl")).toHaveLength(300);
    expect(read("batch-inputs.jsonl")).toHaveLength(BATCH_SIZE);
  });

  it("[FL-098] plans the batch as one sim world with 30 cloned personas, 3 per type", () => {
    const plan = batchPlan(read("batch-inputs.jsonl"), "b20261009");
    expect(plan.worldId).toBe("sim-b20261009");
    expect(plan.personas.map((persona) => persona.key)).toEqual(Array.from({ length: 30 }, (_unused, index) => `b${String(index + 1).padStart(2, "0")}`));
    const perType = new Map<string, number>();
    for (const persona of plan.personas) perType.set(persona.input.type, (perType.get(persona.input.type) ?? 0) + 1);
    expect([...perType.values()]).toEqual(Array(10).fill(BATCH_PER_TYPE));
  });

  it("refuses a batch that is not 30 complaints, 3 of each type, a line that is not JSON or does not match", () => {
    const inputs = read("batch-inputs.jsonl");
    expect(() => batchPlan(inputs.slice(1), "b1")).toThrow(/30 presentations/);
    const other = inputs.find((input) => input.type !== inputs[0]?.type);
    expect(() => batchPlan([...inputs.slice(1), { ...other!, id: "batch-99" }], "b1")).toThrow(/3 presentations of each type/);
    expect(() => batchPlan(inputs, "Not A World")).toThrow();
    expect(() => parseLoadInputs("{not json")).toThrow(/not JSON/);
    expect(() => parseLoadInputs(JSON.stringify({ id: "sim-001", extra: true }))).toThrow(/does not match/);
  });
});
