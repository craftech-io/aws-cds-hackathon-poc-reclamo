// What the two workflows the qa-runner role trusts may spend on the stage (CTO decision: no deployed-stage
// scenario run or evaluation without the CTO's OK). Read from the YAML itself.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRunArgs } from "./run";

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

const stepsOf = (file: string): Step[] => {
  const workflow = parse(read(file)) as { jobs: Record<string, { steps: Step[] }> };
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
};

const read = (path: string): string => readFileSync(path, "utf8");
const DEPLOY_CHECKS = "vars.DEPLOY_CHECKS == 'on'";

describe("deploy.yml: the smoke spends Bedrock only with DEPLOY_CHECKS=on", () => {
  const steps = stepsOf(".github/workflows/deploy.yml");
  const index = (match: (step: Step) => boolean) => steps.findIndex(match);
  const qaRunner = (step: Step) => String(step.with?.["role-session-name"] ?? "").startsWith("github-qa-");
  const smoke = (step: Step) => (step.run ?? "").includes("npm run scenarios");

  it("gates the qa-runner role and SC-00 on the variable, off when unset", () => {
    const gated = steps.filter((step) => qaRunner(step) || smoke(step));
    expect(gated).toHaveLength(2);
    for (const step of gated) expect(step.if, step.name).toContain(DEPLOY_CHECKS);
  });

  it("runs the free interim smoke whenever SC-00 does not", () => {
    const interim = steps.find((step) => (step.run ?? "").includes("scripts/smoke/interim.ts"));
    expect(interim?.if).toContain("vars.DEPLOY_CHECKS != 'on'");
  });

  it("checks for staff with a verified email with the deploy role, after the seed and before qa-runner", () => {
    const check = index((step) => (step.run ?? "").trim() === "npm run console:unverify-staff -- --check");
    expect(check).toBeGreaterThan(index((step) => (step.run ?? "").includes("npm run seed:load")));
    expect(check).toBeLessThan(index(qaRunner));
    expect(steps[check]?.if).toBeUndefined();
  });
});

describe("scenarios.yml: the CTO's OK is the dispatch and its spend ceiling", () => {
  const workflow = parse(read(".github/workflows/scenarios.yml")) as { on: { workflow_dispatch: { inputs: Record<string, { required?: boolean; options?: string[] }> } } };
  const inputs = workflow.on.workflow_dispatch.inputs;
  const run = stepsOf(".github/workflows/scenarios.yml").find((step) => step.name === "Run the suite")?.run ?? "";

  it("requires max_usd and hands it to every suite", () => {
    expect(inputs["max_usd"]?.required).toBe(true);
    expect(run).toContain('npm run scenarios -- --suite eval -- --eval all --confirm-spend --max-usd "${MAX_USD}"');
    expect(run).toContain('npm run scenarios -- --suite batch --confirm-spend --max-cost-usd "${MAX_USD}"');
    expect(run).toContain('npm run scenarios -- --suite "${SUITE}" --max-cost-usd "${MAX_USD}"');
  });

  it("offers only suites the runner accepts", () => {
    for (const suite of inputs["suite"]?.options ?? []) {
      const argv = suite === "eval" ? ["--suite", "eval", "--", "--eval", "all"] : ["--suite", suite, "--max-cost-usd", "60", ...(suite === "batch" ? ["--confirm-spend"] : [])];
      expect(parseRunArgs(argv, { GITHUB_RUN_ID: "1" }).suite, suite).toBe(suite);
    }
  });
});
