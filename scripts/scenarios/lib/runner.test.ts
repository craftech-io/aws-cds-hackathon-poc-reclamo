import { describe, expect, it } from "vitest";
import { needsSrGate, parseRunArgs } from "../run";
import { createDriverClient } from "./driver-client";
import { GuestsActive, noGuestsActive } from "./preflight";
import { type RunReport, flowVerdicts, passRates, renderMarkdown, worst } from "./report";
import { lanesOf, runSuite, tokensPerMinute } from "./runner";
import { defineScenario, type ScenarioDef, type StepDef } from "./steps";
import { scenariosOf } from "./suites";
import { fakeDriver, fakeTime, okWith, refusedWith } from "./testing";

const BUDGET = { maxTurns: 450, maxTokensPerMinute: 10_000_000, usdPerTurn: 0.05 };
const step = (n: number, flows: string[], run: StepDef["run"] = async () => undefined): StepDef => ({ n, title: `step ${n}`, flows, run });
const scenario = (id: string, steps: StepDef[], extra: Partial<ScenarioDef> = {}) => defineScenario({ id, slug: `sc${id.slice(3)}`, title: id, suites: ["full"], steps, ...extra });

/** A driver whose worlds are quiet, audited with `violations` and destroyed at once. */
function stageDriver(violations = 0, turns = 3) {
  return fakeDriver({
    "world.create": okWith({ state: "READY", epoch: 1 }),
    "world.destroy": okWith({ state: "DESTROYED" }),
    "policyAudit.run": okWith({ violations: Array.from({ length: violations }, () => ({})) }),
    snapshot: okWith({ turnsToday: turns, complaints: [], messages: [], timers: [], emails: [], clock: { mode: "PAUSED", pausedSimNow: null } }),
  });
}

const createsWorld = (n: number, flows: string[]) => step(n, flows, async (ctx) => {
  await (await import("./world")).createWorld(ctx, { personas: [{ key: "a", model: "C01" }] });
});

describe("runner (docs/test-plan.md §4.4)", () => {
  it("skips the steps after a failure, still cleans up, and reports a verdict per flow", async () => {
    const driver = stageDriver();
    const suite = [scenario("SC-01", [createsWorld(1, []), step(2, ["FL-010"], async (ctx) => ctx.check(false, "no number")), step(3, ["FL-011"])])];
    const report = await runSuite({ runId: "812-1", suite: "full", scenarios: suite, driver, budget: BUDGET, ...fakeTime() });
    const steps = report.scenarios[0]?.steps.map((one) => one.verdict);
    expect(steps).toEqual(["PASS", "FAIL", "SKIPPED"]);
    expect(report.flows).toEqual({ "FL-010": "FAIL", "FL-011": "SKIPPED" });
    expect(driver.calls.filter((call) => call.key.includes("/999/")).map((call) => call.action)).toEqual(["snapshot", "policyAudit.run", "world.destroy"]);
    expect(report.scenarios[0]?.turns).toBe(3);
    expect(report.verdict).toBe("FAIL");
  });

  it("a step the driver cannot run (NOT_WIRED) is BLOCKED, never a pass; a policy violation fails the scenario", async () => {
    const driver = stageDriver(1);
    const blocked = fakeDriver({ "clock.advance": refusedWith("UNAVAILABLE", "NOT_WIRED") });
    const one = await runSuite({ runId: "812-1", suite: "full", scenarios: [scenario("SC-05", [step(7, ["FL-040"], async (ctx) => void (await ctx.qa("clock.advance", { worldId: "qa-812-1-sc05", minutes: 1 })))])], driver: blocked, budget: BUDGET, ...fakeTime() });
    expect(one.scenarios[0]?.steps[0]?.verdict).toBe("BLOCKED");
    const two = await runSuite({ runId: "812-1", suite: "full", scenarios: [scenario("SC-01", [createsWorld(1, [])])], driver, budget: BUDGET, ...fakeTime() });
    expect(two.scenarios[0]?.audits).toEqual([{ worldId: "qa-812-1-sc01", violations: 1 }]);
    expect(two.verdict).toBe("FAIL");
  });

  it("stops starting scenarios once the turn budget is spent", async () => {
    const report = await runSuite({ runId: "812-1", suite: "full", scenarios: [scenario("SC-01", [createsWorld(1, [])]), scenario("SC-02", [createsWorld(1, ["FL-016"])])], driver: stageDriver(0, 5), budget: { ...BUDGET, maxTurns: 5 }, parallel: 1, ...fakeTime() });
    expect(report.scenarios.map((one) => one.verdict)).toEqual(["PASS", "SKIPPED"]);
    expect(report.budget).toMatchObject({ turns: 5, aborted: "turn budget of 5 reached", estimatedCostUsd: 0.25 });
  });

  it("puts lanes, scenarios that run alone and the last one in their place", () => {
    const sc22 = scenario("SC-22", [], { lane: "guest", laneOrder: 1 });
    const sc21 = scenario("SC-21", [], { lane: "guest", laneOrder: 2 });
    const sc20 = scenario("SC-20", [], { last: true });
    const sc24 = scenario("SC-24", [], { alone: true });
    const { lanes, alone, last } = lanesOf([scenario("SC-01", []), sc21, sc22, sc24, sc20]);
    expect(lanes.map((lane) => lane.map((one) => one.id))).toEqual([["SC-01"], ["SC-22", "SC-21"]]);
    expect(alone.map((one) => one.id)).toEqual(["SC-24"]);
    expect(last.map((one) => one.id)).toEqual(["SC-20"]);
    expect(scenariosOf([sc22, scenario("SC-23", [], { onDemand: true })], "full").map((one) => one.id)).toEqual(["SC-22"]);
  });

  it("estimates the tokens per minute of the run", () => {
    expect(tokensPerMinute(10, 60_000)).toBe(610_000);
    expect(tokensPerMinute(0, 0)).toBe(0);
  });
});

describe("report: verdicts and the pass rate of three runs (docs/test-plan.md §1.3)", () => {
  const run = (runId: string, verdict: "PASS" | "FAIL"): RunReport => {
    const scenarios = [{ scenario: "SC-01", title: "", verdict, durationMs: 1, turns: 1, audits: [], steps: [{ step: 5, title: "", flows: ["FL-017"], verdict, durationMs: 1, ids: {}, measures: { ackLatencyMs: 900 }, blocks: [], warnings: [] }] }];
    return { runId, suite: "full", startedAt: "", finishedAt: "", durationMs: 1, verdict, scenarios, flows: flowVerdicts(scenarios), budget: { maxTurns: 450, turns: 1, estimatedCostUsd: 0.05 } };
  };

  it("takes the worst verdict, and a step that passed 2 of 3 runs is not proven", () => {
    expect(worst(["PASS", "WARN"])).toBe("WARN");
    expect(worst(["PASS", "SKIPPED", "BLOCKED"])).toBe("BLOCKED");
    const rates = passRates([run("1-1", "PASS"), run("2-1", "FAIL"), run("3-1", "PASS")]);
    expect(rates.steps["SC-01/5"]).toEqual({ passed: 2, runs: 3 });
    expect(rates.flows["FL-017"]).toEqual({ passed: 2, runs: 3 });
    expect(rates.unproven).toEqual(["SC-01/5", "FL-017"]);
    expect(passRates([run("1-1", "PASS"), run("2-1", "PASS"), run("3-1", "PASS")]).unproven).toEqual([]);
  });

  it("renders measures and the policy audit row without any address", () => {
    const markdown = renderMarkdown(run("1-1", "PASS"));
    expect(markdown).toContain("ackLatencyMs=900");
    expect(markdown).toContain("| SC-01 | policy audit | FL-075 |");
    expect(markdown).not.toMatch(/@/);
  });
});

describe("preflight without guests (docs/test-plan.md §4.4)", () => {
  it("waits while somebody used the agent in the last 15 minutes, and goes on when they stopped", async () => {
    const answers = [3, 1, 0];
    const time = fakeTime();
    const result = await noGuestsActive({ count: async () => answers.shift() ?? 0, force: false, ...time });
    expect(result).toEqual({ guestTurns: 0, waitedSec: 120, forced: false });
  });

  it("gives up after 30 minutes, unless forced", async () => {
    await expect(noGuestsActive({ count: async () => 2, force: false, ...fakeTime() })).rejects.toThrow(GuestsActive);
    expect(await noGuestsActive({ count: async () => 2, force: true, ...fakeTime() })).toEqual({ guestTurns: 2, waitedSec: 0, forced: true });
  });
});

describe("driver client: retries (docs/tool-catalog.md \"Acciones del QaDriver\")", () => {
  const ok = JSON.stringify({ ok: true, replayed: false, result: {} });

  it("retries a throttle under the same key, and a read after a transport failure", async () => {
    const payloads: string[] = [];
    let calls = 0;
    const client = createDriverClient({ sleep: async () => undefined, invoke: async (payload) => {
      payloads.push(payload);
      calls += 1;
      return calls === 1 ? { statusCode: 429, payload: "" } : { statusCode: 200, payload: ok };
    } });
    await client.call("world.create", { runId: "812-1", scenario: "sc01" }, "812-1/sc01/1/m1");
    expect(new Set(payloads).size).toBe(1);
    let reads = 0;
    const flaky = createDriverClient({ sleep: async () => undefined, invoke: async () => (++reads === 1 ? Promise.reject(new Error("socket hang up")) : { statusCode: 200, payload: ok }) });
    await flaky.call("snapshot", { worldId: "qa-812-1-sc01" }, "812-1/sc01/1/r1");
    expect(reads).toBe(2);
  });

  it("never repeats a changing action after a transport failure", async () => {
    let calls = 0;
    const client = createDriverClient({ sleep: async () => undefined, invoke: async () => {
      calls += 1;
      throw new Error("socket hang up");
    } });
    await expect(client.call("wa.inbound", {}, "812-1/sc01/2/m1")).rejects.toThrow("socket hang up");
    expect(calls).toBe(1);
  });
});

describe("run.ts arguments", () => {
  it("defaults to the smoke with the CI run id; the full suite takes 450 turns", () => {
    expect(parseRunArgs([], { GITHUB_RUN_ID: "8123", GITHUB_RUN_ATTEMPT: "2" })).toMatchObject({ suite: "smoke", runId: "8123-2", maxTurns: 40 });
    expect(parseRunArgs(["--suite", "full", "--force", "--max-cost-usd", "30"], {})).toMatchObject({ suite: "full", maxTurns: 450, maxCostUsd: 30, force: true });
    expect(parseRunArgs(["--scenario", "SC-01", "--scenario", "SC-03"], { GITHUB_RUN_ID: "1" })).toMatchObject({ suite: "full", scenarios: ["SC-01", "SC-03"] });
    expect(parseRunArgs(["--merge", "a.json", "b.json"], {}).merge).toEqual(["a.json", "b.json"]);
  });

  it("forwards what follows -- to the evaluations, and only for --suite eval", () => {
    const args = parseRunArgs(["--suite", "eval", "--", "--eval", "all", "--confirm-spend", "--max-usd", "60"], {});
    expect(args).toMatchObject({ suite: "eval", evalArgs: ["--eval", "all", "--confirm-spend", "--max-usd", "60"], maxTurns: 0 });
    expect(parseRunArgs(["--suite", "eval"], {}).evalArgs).toEqual([]);
    expect(() => parseRunArgs(["--suite", "full", "--", "--eval", "all"], {})).toThrow(RangeError);
    expect(() => parseRunArgs(["--suite", "eval", "--scenario", "SC-01"], {})).toThrow(RangeError);
  });

  it("takes --suite batch with the spend confirmed, and --confirm-spend for nothing else", () => {
    expect(parseRunArgs(["--suite", "batch", "--confirm-spend", "--max-cost-usd", "12", "--batch-id", "b2"], { GITHUB_RUN_ID: "7" })).toMatchObject({ suite: "batch", confirmSpend: true, maxCostUsd: 12, batchId: "b2", runId: "7-1" });
    expect(parseRunArgs(["--suite", "batch"], {})).toMatchObject({ confirmSpend: false, batchId: "b1" });
    expect(() => parseRunArgs(["--suite", "full", "--confirm-spend"], {})).toThrow(RangeError);
    expect(() => parseRunArgs(["--suite", "batch", "--batch-id", "B 1"], {})).toThrow(RangeError);
  });

  it("puts the SR gate before the full suite only, never before the smoke or named scenarios", () => {
    expect(needsSrGate(parseRunArgs(["--suite", "full"], {}))).toBe(true);
    expect(needsSrGate(parseRunArgs(["--suite", "smoke"], {}))).toBe(false);
    expect(needsSrGate(parseRunArgs(["--scenario", "SC-03"], {}))).toBe(false);
  });

  it("refuses an unknown suite, a malformed run id and a typo", () => {
    expect(() => parseRunArgs(["--suite", "load"], {})).toThrow(RangeError);
    expect(() => parseRunArgs(["--run-id", "local-1"], {})).toThrow();
    expect(() => parseRunArgs(["--sute", "full"], {})).toThrow(RangeError);
  });

  it("takes --live only with SC-23 named (live WhatsApp is attended and never joins a suite)", () => {
    expect(parseRunArgs(["--scenario", "SC-23", "--live"], { GITHUB_RUN_ID: "1" })).toMatchObject({ scenarios: ["SC-23"], live: true });
    expect(parseRunArgs(["--suite", "full"], {}).live).toBe(false);
    expect(() => parseRunArgs(["--suite", "full", "--live"], {})).toThrow(RangeError);
  });
});
