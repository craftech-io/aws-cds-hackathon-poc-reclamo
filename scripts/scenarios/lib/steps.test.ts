import { describe, expect, it } from "vitest";
import { WaitTimeout, eventually } from "./eventually";
import { AssertionFailed, DriverRefusal, ScenarioBug, defineScenario, emptyRecord, stepContext } from "./steps";
import { fakeDriver, fakeTime, okWith, refusedWith, snapshotStub } from "./testing";

const scenario = defineScenario({ id: "SC-01", slug: "sc01", title: "test", suites: ["full"], steps: [] });
const WORLD = "qa-812-1-sc01";

function contextWith(driver: ReturnType<typeof fakeDriver>, step = 3, time = fakeTime()) {
  return stepContext({ runId: "812-1", scenario, driver, state: {}, waitOptions: time }, step, emptyRecord());
}

/** `conv.settleProbe` answering the given sequence of `settled` values, then `settled` for ever. */
function settleSequence(values: readonly boolean[]) {
  let index = 0;
  return () => ({ ok: true as const, replayed: false, result: { settled: values[index++] ?? true, pending: [] } });
}

describe("step context: keys (docs/test-plan.md §4.4)", () => {
  it("labels changing calls m1, m2… and reads r1, r2… under <runId>/<scenario>/<step>", async () => {
    const driver = fakeDriver();
    const ctx = contextWith(driver);
    await ctx.qa("clock.advance", { worldId: WORLD, minutes: 60 });
    await ctx.qa("snapshot", { worldId: WORLD });
    await ctx.qa("wa.inbound", { worldId: WORLD, persona: "a", content: { type: "text", text: "hola" } });
    await ctx.qa("console", { worldId: WORLD, procedure: "complaints.get", role: "OPERATOR", input: { complaintId: "cmp-1" } });
    await ctx.qa("console", { worldId: WORLD, procedure: "approvals.decide", role: "OPERATOR", input: {} });
    expect(driver.calls.map((call) => call.key)).toEqual(["812-1/sc01/3/m1", "812-1/sc01/3/r1", "812-1/sc01/3/m2", "812-1/sc01/3/r2", "812-1/sc01/3/m3"]);
  });

  it("the same step run again produces the same keys, so the driver replays instead of acting twice", async () => {
    const first = fakeDriver();
    const again = fakeDriver();
    for (const driver of [first, again]) {
      const ctx = contextWith(driver);
      await ctx.qa("clock.advance", { worldId: WORLD, minutes: 60 });
      await ctx.qa("event.poison", { worldId: WORLD, customerId: "cus-qa-812-1-sc01-a" });
    }
    expect(again.calls.map((call) => call.key)).toEqual(first.calls.map((call) => call.key));
  });

  it("a change polled as a probe keeps one key for every poll", async () => {
    const driver = fakeDriver({ "world.create": okWith({ state: "CREATING" }) });
    const ctx = contextWith(driver);
    const create = ctx.repeatable("world.create", { runId: "812-1", scenario: "sc01" });
    await create();
    await create();
    await ctx.qa("clock.advance", { worldId: WORLD, minutes: 1 });
    expect(driver.calls.map((call) => call.key)).toEqual(["812-1/sc01/3/m1", "812-1/sc01/3/m1", "812-1/sc01/3/m2"]);
  });

  it("turns a refusal into DriverRefusal with its code and reason; attempt returns it as it is", async () => {
    const driver = fakeDriver({ "clock.advance": refusedWith("UNAVAILABLE", "NOT_WIRED") });
    const ctx = contextWith(driver);
    await expect(ctx.qa("clock.advance", { worldId: WORLD, minutes: 1 })).rejects.toMatchObject({ name: "DriverRefusal", code: "UNAVAILABLE", reason: "NOT_WIRED" });
    expect(await ctx.attempt("clock.advance", { worldId: WORLD, minutes: 1 })).toMatchObject({ ok: false, error: { reason: "NOT_WIRED" } });
    expect(new DriverRefusal("snapshot", "NOT_FOUND", undefined, "x").message).toContain("snapshot: NOT_FOUND");
  });
});

describe("step context: quiet before a negative (docs/test-plan.md §4.3 Quiescencia)", () => {
  it("refuses a negative or an exact count on a snapshot that was not read with the world quiet", async () => {
    const ctx = contextWith(fakeDriver({ snapshot: okWith(snapshotStub()) }));
    const plain = await ctx.snapshot(WORLD);
    expect(() => ctx.none(plain, "messages", [])).toThrow(ScenarioBug);
    expect(() => ctx.exactly(plain, 0, "messages", [])).toThrow(ScenarioBug);
  });

  it("settles with two `settled` answers 10 s apart, an unsettled answer starting over", async () => {
    const time = fakeTime();
    const driver = fakeDriver({ "conv.settleProbe": settleSequence([true, false, true, true]), snapshot: () => ({ ok: true, replayed: false, result: snapshotStub() }) });
    const ctx = contextWith(driver, 3, time);
    const settled = await ctx.settled(WORLD, "cus-a");
    const probes = driver.calls.filter((call) => call.action === "conv.settleProbe");
    expect(probes).toHaveLength(4);
    expect(probes[0]?.input).toEqual({ worldId: WORLD, customerId: "cus-a" });
    expect(time.now()).toBeGreaterThanOrEqual(30_000);
    expect(() => ctx.none(settled, "messages", [])).not.toThrow();
    expect(ctx.exactly(settled, 1, "complaints", ["one"])).toEqual(["one"]);
    expect(() => ctx.none(settled, "messages", ["x"])).toThrow(AssertionFailed);
  });

  it("a change after the quiet read makes the next negative a scenario bug", async () => {
    const driver = fakeDriver({ "conv.settleProbe": settleSequence([]), snapshot: () => ({ ok: true, replayed: false, result: snapshotStub() }) });
    const ctx = contextWith(driver);
    const settled = await ctx.settled(WORLD);
    const timeline = await ctx.quietRead(WORLD, async () => ({ items: [] as string[] }));
    expect(() => ctx.none(timeline, "tape entries", timeline.items)).not.toThrow();
    await ctx.qa("wa.inbound", { worldId: WORLD, persona: "a", content: { type: "text", text: "hola" } });
    expect(() => ctx.none(settled, "messages", [])).toThrow(ScenarioBug);
    expect(() => ctx.none(timeline, "tape entries", [])).toThrow(ScenarioBug);
  });

  it("never settles a world that keeps working: the wait times out", async () => {
    const ctx = contextWith(fakeDriver({ "conv.settleProbe": okWith({ settled: false, pending: [{ kind: "EVENT" }] }) }));
    await expect(ctx.settled(WORLD, undefined, 60)).rejects.toThrow(WaitTimeout);
  });

  it("records ids, measures, blocks and warnings for the report", () => {
    const own = emptyRecord();
    const ctx = stepContext({ runId: "812-1", scenario, driver: fakeDriver(), state: {} }, 1, own);
    ctx.note("world", WORLD);
    ctx.measure("ackLatencyMs", 812);
    ctx.blocked("CHANNEL_POLICY", "CH-WA-NO-COLLECTION");
    ctx.warn("answered by the ANSWER_DUE obligation");
    expect(own).toEqual({ ids: { world: WORLD }, measures: { ackLatencyMs: 812 }, blocks: [{ origin: "CHANNEL_POLICY", detail: "CH-WA-NO-COLLECTION" }], warnings: ["answered by the ANSWER_DUE obligation"] });
  });

  it("refuses a scenario whose step numbers repeat, or whose slug would not make a QA world id", () => {
    const step = { n: 1, title: "x", flows: [], run: async () => undefined };
    expect(() => defineScenario({ ...scenario, steps: [step, step] })).toThrow(RangeError);
    expect(() => defineScenario({ ...scenario, slug: "SC-01" })).toThrow(RangeError);
  });
});

describe("eventually (docs/test-plan.md §4.3 Esperas)", () => {
  it("polls until the probe answers something, retrying a probe that throws", async () => {
    let attempts = 0;
    const found = await eventually(
      "the thing",
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("not yet");
        return attempts === 3 ? "done" : undefined;
      },
      { timeoutSec: 60, everySec: 5, ...fakeTime() },
    );
    expect(found).toBe("done");
    expect(attempts).toBe(3);
  });

  it("times out naming what it waited for and the last error", async () => {
    await expect(eventually("the reply", async () => { throw new Error("still busy"); }, { timeoutSec: 30, ...fakeTime() })).rejects.toThrow("the reply: not reached within 30 s (last: still busy)");
    await expect(eventually("the reply", async () => false, { timeoutSec: 30, ...fakeTime() })).rejects.toThrow(WaitTimeout);
  });
});
