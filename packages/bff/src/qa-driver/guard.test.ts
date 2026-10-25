import { describe, expect, it } from "vitest";
import { ToolError } from "@reclamo/shared";
import { keys } from "../connector/keys";
import { testConnector } from "../connector/testing";
import { dispatchScheduled } from "../timers/dispatch";
import { scheduleNameOf } from "../timers/schedule-name";
import { START_SIM, timersKit } from "../timers/testing";
import { type QaActionName, QA_REASON } from "./contract";
import { createQaDriver } from "./driver";
import { checkFence, guard, scopeOf, worldClassOf } from "./guard";
import { ACTION_HANDLERS } from "./handlers";
import { ACTION_INPUTS } from "./inputs";
import { QA_WORLD, RUN, key, qaKit } from "./testing";

function fenceOf(action: QaActionName, input: unknown, idempotencyKey = key(1)): string {
  try {
    guard(action, ACTION_INPUTS[action].parse(input), idempotencyKey);
    return "ALLOWED";
  } catch (error) {
    if (error instanceof ToolError) return `${error.code}${error.reason ? ` ${error.reason}` : ""}`;
    throw error;
  }
}

const FORBIDDEN = `FORBIDDEN ${QA_REASON.QA_FENCE}`;

describe("world classes", () => {
  it("[FL-099] are read from the world id alone", () => {
    expect(worldClassOf(QA_WORLD)).toBe("QA");
    expect(worldClassOf(`qa-live-${RUN}`)).toBe("QA");
    expect(worldClassOf("qamin")).toBe("QAMIN");
    expect(worldClassOf("sim-4242-1-b1")).toBe("SIM");
    expect(worldClassOf("gprobe")).toBe("GPROBE");
    for (const worldId of ["demo", "g01", "g99", "gtest", "gs-abcdefghij", "qa"]) expect(worldClassOf(worldId), worldId).toBe("OTHER");
  });
});

describe("the fence of the QaDriver [FL-099]", () => {
  it("[FL-099] lets every world action act on a qa-* world of the key's own run", () => {
    expect(fenceOf("kill.setWorld", { worldId: QA_WORLD, on: true })).toBe("ALLOWED");
    expect(fenceOf("snapshot", { worldId: QA_WORLD })).toBe("ALLOWED");
    expect(fenceOf("console", { worldId: QA_WORLD, procedure: "clock.get", role: "GUEST" })).toBe("ALLOWED");
    expect(fenceOf("world.destroy", { worldId: `qa-live-${RUN}` })).toBe("ALLOWED");
  });

  it("[FL-099] refuses demo, every guest world and gtest, for every action, before anything runs", () => {
    for (const worldId of ["demo", "g01", "gtest", "gs-abcdefghij"]) {
      expect(fenceOf("snapshot", { worldId }), worldId).toBe(FORBIDDEN);
      expect(fenceOf("kill.setWorld", { worldId, on: true }), worldId).toBe(FORBIDDEN);
      expect(fenceOf("wa.inbound", { worldId, persona: "C01", content: { type: "text", text: "hola" } }), worldId).toBe(FORBIDDEN);
      expect(fenceOf("console", { worldId, procedure: "clock.get", role: "OPERATOR" }), worldId).toBe(FORBIDDEN);
      expect(fenceOf("caps.prime", { worldId, bucket: "TURNCAP", value: 10 }), worldId).toBe(FORBIDDEN);
    }
  });

  it("[FL-099] refuses a qa-* world of another run", () => {
    expect(fenceOf("snapshot", { worldId: "qa-9999-1-sc01" })).toBe(FORBIDDEN);
    expect(fenceOf("guest.signup", { runId: "9999-1", key: "su1", locale: "es" })).toBe(FORBIDDEN);
  });

  it("[FL-099] keeps qamin to its closed list", () => {
    for (const allowed of [
      fenceOf("wa.inbound", { worldId: "qamin", persona: "C01", content: { type: "text", text: "hola" } }),
      fenceOf("snapshot", { worldId: "qamin" }),
      fenceOf("conv.settleProbe", { worldId: "qamin" }),
      fenceOf("memory.inspect", { worldId: "qamin", customerId: "cus-0001" }),
      fenceOf("metrics.get", { worldId: "qamin" }),
      fenceOf("console", { worldId: "qamin", procedure: "clock.reset", role: "OPERATOR" }),
      fenceOf("console", { worldId: "qamin", procedure: "clock.resetStatus", role: "COMPLIANCE" }),
    ]) {
      expect(allowed).toBe("ALLOWED");
    }
    expect(fenceOf("world.destroy", { worldId: "qamin" })).toBe(FORBIDDEN);
    expect(fenceOf("kill.setWorld", { worldId: "qamin", on: true })).toBe(FORBIDDEN);
    expect(fenceOf("clock.advance", { worldId: "qamin", minutes: 5 })).toBe(FORBIDDEN);
    expect(fenceOf("console", { worldId: "qamin", procedure: "clock.advance", role: "OPERATOR" })).toBe(FORBIDDEN);
    expect(fenceOf("console", { worldId: "qamin", procedure: "clock.reset", role: "GUEST" })).toBe(FORBIDDEN);
  });

  it("[FL-099] lets gprobe be read only by fence.probe(WORLD_PATHS)", () => {
    expect(fenceOf("fence.probe", { kind: "WORLD_PATHS", worldId: "gprobe" })).toBe("ALLOWED");
    expect(fenceOf("fence.probe", { kind: "RECIPIENT", worldId: "gprobe", channel: "EMAIL", address: "success@simulator.amazonses.com" })).toBe(FORBIDDEN);
    expect(fenceOf("snapshot", { worldId: "gprobe" })).toBe(FORBIDDEN);
    expect(fenceOf("schedule.fireStale", { worldId: "gprobe", timerKey: "W#gprobe#TIMER#SLA#x", version: 1, epoch: 1 })).toBe(FORBIDDEN);
  });

  it("[FL-099] keeps batch.run to its own sim-* worlds, and sim-* to batch.run", () => {
    expect(scopeOf("batch.run", ACTION_INPUTS["batch.run"].parse({ runId: RUN, batchId: "b1" }), key(1))).toEqual({ name: "batch.run", worldId: `sim-${RUN}-b1` });
    expect(fenceOf("batch.run", { runId: RUN, batchId: "b1" })).toBe("ALLOWED");
    expect(fenceOf("batch.run", { runId: "9999-1", batchId: "b1" })).toBe(FORBIDDEN);
    expect(fenceOf("snapshot", { worldId: `sim-${RUN}-b1-1` })).toBe(FORBIDDEN);
    expect(() => checkFence({ name: "batch.run", worldId: QA_WORLD }, key(1))).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("[FL-099] binds world.create to the key's run and scenario, and runner sign-ups to qa-<runId>-su<n>", () => {
    expect(fenceOf("world.create", { runId: RUN, scenario: "sc01" })).toBe("ALLOWED");
    expect(fenceOf("world.create", { runId: RUN, scenario: "sc02" })).toBe(`INVALID ${QA_REASON.KEY_WORLD_MISMATCH}`);
    expect(scopeOf("guest.confirm", ACTION_INPUTS["guest.confirm"].parse({ runId: RUN, key: "su1", signupId: "a".repeat(26) }), key(1)).worldId).toBe(`qa-${RUN}-su1`);
    expect(fenceOf("guest.expireNow", { worldId: QA_WORLD })).toBe(FORBIDDEN);
    expect(fenceOf("guest.expireNow", { worldId: `qa-${RUN}-su1` })).toBe("ALLOWED");
  });

  it("[FL-099] admits GUEST only in qa-* worlds and global caps only in their QA buckets", () => {
    expect(fenceOf("console", { worldId: "qamin", procedure: "metrics.summary", role: "GUEST" })).toBe(FORBIDDEN);
    expect(fenceOf("caps.prime", { bucket: "GLOBALCAP_QA", value: 99 })).toBe("ALLOWED");
    expect(fenceOf("caps.prime", { bucket: "TURNCAP", value: 99 })).toBe("INVALID");
    expect(fenceOf("caps.prime", { worldId: QA_WORLD, bucket: "SIGNUP_QA", value: 1 })).toBe("INVALID");
  });
});

describe("the driver: fence first, then idempotency by key", () => {
  it("[FL-099] answers FORBIDDEN without writing anything outside the QA worlds", async () => {
    const mc = testConnector();
    const { driver } = qaKit({ mc });
    expect(await driver({ action: "kill.setWorld", idempotencyKey: key(1), input: { worldId: "demo", on: true } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: QA_REASON.QA_FENCE } });
    expect(await mc.connector.runtime.isAgentKilled("demo")).toBe(false);
  });

  it("[FL-099] refuses a malformed envelope and an unknown key of an input", async () => {
    const { driver } = qaKit({ mc: testConnector() });
    expect(await driver({ action: "snapshot", idempotencyKey: "nope", input: { worldId: QA_WORLD } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await driver({ action: "kill.setWorld", idempotencyKey: key(1), input: { worldId: QA_WORLD, on: true, caller: "x" } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("[FL-099] a retried step answers its first result and never repeats the effect", async () => {
    const mc = testConnector();
    const { driver } = qaKit({ mc });
    const first = await driver({ action: "kill.setWorld", idempotencyKey: key(2), input: { worldId: QA_WORLD, on: true } });
    expect(first).toEqual({ ok: true, replayed: false, result: { worldId: QA_WORLD, on: true } });
    await mc.connector.runtime.setKill({ worldId: QA_WORLD, on: false, by: "QA", atReal: new Date().toISOString() });
    const retried = await driver({ action: "kill.setWorld", idempotencyKey: key(2), input: { worldId: QA_WORLD, on: true } });
    expect(retried).toEqual({ ok: true, replayed: true, result: { worldId: QA_WORLD, on: true } });
    expect(await mc.connector.runtime.isAgentKilled(QA_WORLD)).toBe(false);
    expect(await driver({ action: "kill.setWorld", idempotencyKey: key(2), input: { worldId: QA_WORLD, on: false } })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: QA_REASON.IDEMPOTENCY_KEY_REUSED } });
  });

  it("[FL-099] never remembers a probe still working, nor a login", async () => {
    const mc = testConnector();
    const kit = qaKit({ mc });
    let calls = 0;
    const states = ["DESTROYING", "DESTROYING", "DESTROYED"];
    const driver = createQaDriver({ ports: kit.ports, handlers: { ...ACTION_HANDLERS, "world.destroy": async () => ({ state: states[calls++] }) }, loggerFor: () => kit.log });
    const step = { action: "world.destroy", idempotencyKey: key(3), input: { worldId: QA_WORLD } };
    expect(await driver(step)).toMatchObject({ replayed: false, result: { state: "DESTROYING" } });
    expect(await driver(step)).toMatchObject({ replayed: false, result: { state: "DESTROYING" } });
    expect(await driver(step)).toMatchObject({ replayed: false, result: { state: "DESTROYED" } });
    expect(await driver(step)).toMatchObject({ replayed: true, result: { state: "DESTROYED" } });
    expect(calls).toBe(3);
  });
});

describe("schedule.fireStale [FL-081]", () => {
  it("[FL-081] rejects a world that is not qa-*", () => {
    for (const worldId of ["qamin", "demo", "g01", "gs-abcdefghij", "gprobe"]) {
      expect(fenceOf("schedule.fireStale", { worldId, timerKey: `W#${worldId}#TIMER#SLA#x`, version: 1, epoch: 1 }), worldId).toBe(FORBIDDEN);
    }
  });

  it("[FL-081] a stale version or epoch reaches the real ScheduleDispatch and is discarded without effect", async () => {
    const timers = timersKit();
    await timers.seedWorld(QA_WORLD, START_SIM);
    await timers.putTimers(QA_WORLD, { kind: "FOLLOW_UP", timerId: "f1", dueAtSim: START_SIM, payload: { complaintId: "cmp-0001" } });
    const stored = await timers.getTimer(QA_WORLD, "FOLLOW_UP", "f1");
    const timerKey = keys.timerKey(QA_WORLD, "FOLLOW_UP", "f1");
    const kit = qaKit({
      mc: { connector: timers.connector, store: timers.store },
      overrides: { scheduleDispatch: { scheduleArn: (name) => `arn:aws:scheduler:us-east-1:776805327629:schedule/g/${name}`, invoke: (input) => dispatchScheduled(input, timers.deps) } },
    });
    const staleVersion = await kit.driver({ action: "schedule.fireStale", idempotencyKey: key(4), input: { worldId: QA_WORLD, timerKey, version: (stored?.version ?? 1) + 1, epoch: 1 } });
    expect(staleVersion).toMatchObject({ ok: true, result: { answer: { status: "LATE_FIRE_DISCARDED", reason: "STALE_VERSION" } } });
    const staleEpoch = await kit.driver({ action: "schedule.fireStale", idempotencyKey: key(5), input: { worldId: QA_WORLD, timerKey, version: stored?.version ?? 1, epoch: 0 } });
    expect(staleEpoch).toMatchObject({ ok: true, result: { answer: { status: "LATE_FIRE_DISCARDED", reason: "TOMBSTONED" } } });
    expect(await timers.getTimer(QA_WORLD, "FOLLOW_UP", "f1")).toMatchObject({ status: "SCHEDULED", version: stored?.version });
    expect(timers.events).toEqual([]);
    expect(scheduleNameOf(QA_WORLD, 1, timerKey)).toMatch(/^tm-qa-/);
  });
});
