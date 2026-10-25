// The map of support/scenario-map.ts stays in step with what exists: every scenario of scripts/scenarios
// is mapped, every agent test file it names exists and every flow it cites is in docs/flows-catalog.md.
// It needs no model, so it runs on every suite that includes it, scripted runs too.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCENARIO_MAP } from "../support/scenario-map";

const AGENT_DIR = "tests/agent";

describe("scenario map", () => {
  it("maps every scenario of scripts/scenarios, and only those", () => {
    const scenarios = readdirSync("scripts/scenarios")
      .flatMap((file) => /^sc-(\d{2})-.*\.ts$/.exec(file)?.[1] ?? [])
      .map((number) => `SC-${number}`)
      .sort();
    expect(Object.keys(SCENARIO_MAP).sort()).toEqual(scenarios);
  });

  it("names agent test files that exist and flows the catalog has", () => {
    const catalog = new Set([...readFileSync("docs/flows-catalog.md", "utf8").matchAll(/^### (FL-\d{3})\b/gm)].map((match) => match[1]));
    const coverage = Object.values(SCENARIO_MAP);
    expect(coverage.flatMap((entry) => entry.agent).filter((file) => !existsSync(join(AGENT_DIR, file)))).toEqual([]);
    expect(coverage.flatMap((entry) => entry.flows).filter((flow) => !catalog.has(flow))).toEqual([]);
    expect(coverage.filter((entry) => entry.agent.length === 0 && entry.flows.length === 0)).toEqual([]);
  });
});
