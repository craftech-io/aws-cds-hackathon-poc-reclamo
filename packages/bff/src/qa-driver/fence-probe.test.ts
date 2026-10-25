import { describe, expect, it } from "vitest";
import type { SnsRecord, WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import { verifySimulatedRecord } from "../channels/whatsapp/sim-envelope";
import { TEST_SIM_KEYS } from "../channels/whatsapp/testing";
import { TEST_NOW, worldMeta } from "../connector/testing";
import { createLogger } from "../lib/log";
import { dispatchScheduled } from "../timers/dispatch";
import type { TimerDeps } from "../timers/deps";
import { START_SIM } from "../timers/testing";
import { UNLIMITED } from "../worlds/deps";
import { runJanitor } from "../worlds/janitor";
import { worldsRig } from "../worlds/testing";
import type { QaPorts } from "./ports";
import { PROBE_WORLD, gprobeHash } from "./fence-probe";
import { key, qaKit } from "./testing";

/** What InboundWhatsApp answers for a simulated record: the real envelope check, with both keys linked. */
function inboundAnswer(event: WhatsAppSnsEvent) {
  const verified = verifySimulatedRecord(event.Records[0] as SnsRecord, TEST_SIM_KEYS, TEST_NOW);
  return { records: [{ accepted: verified.ok, ...(verified.ok ? {} : { reason: verified.reason }), messages: [] }] };
}

/** `gprobe` as seed:load leaves it: READY, its clock paused, a pending milestone. */
async function probeRig(overrides: (rig: ReturnType<typeof worldsRig>) => Partial<QaPorts> = () => ({})) {
  const rig = worldsRig({ start: TEST_NOW.toISOString() });
  const { connector } = rig.mc;
  await connector.worlds.register(worldMeta(PROBE_WORLD, { kind: "GUEST", template: "qa-min", status: "READY" }));
  await connector.transact([connector.counters.initEpochOp(PROBE_WORLD, 1)]);
  await connector.runtime.putClock({ worldId: PROBE_WORLD, mode: "PAUSED", pausedSimNow: START_SIM, worldEpoch: 1 });
  await connector.timers.put({ worldId: PROBE_WORLD, kind: "SLA", timerId: "cmp-h000001-DEADLINE", dueAtSim: "2026-10-21T23:59:59-03:00", seq: 0, status: "SCHEDULED", epoch: 1, ownerKey: "CMP#cmp-h000001", payload: {} });
  let ids = 0;
  const timers: TimerDeps = { connector, sink: { enqueue: async () => undefined }, log: createLogger({ level: "error" }), realNow: () => TEST_NOW, newId: (prefix) => `${prefix}-${(ids += 1)}` };
  const kit = qaKit({
    mc: rig.mc,
    overrides: {
      inbound: { key: () => TEST_SIM_KEYS.qa, deliver: async (event) => inboundAnswer(event) },
      scheduleDispatch: { scheduleArn: (name) => `arn:aws:scheduler:us-east-1:776805327629:schedule/g/${name}`, invoke: (input) => dispatchScheduled(input, timers) },
      janitorDirect: (event) => runJanitor(rig.deps, event, UNLIMITED),
      ...overrides(rig),
    },
  });
  return { rig, kit };
}

const probe = { action: "fence.probe", idempotencyKey: key(1, "sc18"), input: { kind: "WORLD_PATHS", worldId: PROBE_WORLD } };

describe("fence.probe(WORLD_PATHS) against gprobe [FL-099]", () => {
  it("[FL-099] [FL-081] every path is refused by the Lambda it reaches, and gprobe does not move", async () => {
    const { kit } = await probeRig();
    const answer = await kit.driver(probe);
    expect(answer.ok).toBe(true);
    const result = (answer as { result: { refused: boolean; hashBefore: string; hashAfter: string; paths: { path: string; refused: boolean; answer: string }[] } }).result;
    expect(result.paths).toEqual([
      { path: "a.InboundWhatsApp", refused: true, answer: "SIM_KEY_WORLD_MISMATCH" },
      { path: "b.ScheduleDispatch", refused: true, answer: "EARLY_FIRE_DISCARDED CLOCK_PAUSED" },
      { path: "c.CoreMock.url", refused: true, answer: "403 CALLER_WORLD_DENIED" },
      { path: "c.NetworkMock.url", refused: true, answer: "403 CALLER_WORLD_DENIED" },
      { path: "c.CoreMock.invoke", refused: true, answer: "AccessDeniedException" },
      { path: "c.NetworkMock.invoke", refused: true, answer: "AccessDeniedException" },
      { path: "d.WorldJanitor.MEMORY_PURGE", refused: true, answer: "MISSING" },
      { path: "d.WorldJanitor.MEMORY_PURGE.extra", refused: true, answer: "INVALID" },
      { path: "d.WorldJanitor.WORLD_RESET", refused: true, answer: "MISSING" },
      { path: "d.WorldJanitor.WORLD_RESET.extra", refused: true, answer: "INVALID" },
    ]);
    expect(result.hashAfter).toBe(result.hashBefore);
    expect(result.refused).toBe(true);
  });

  it("[FL-099] a path that is let through fails the probe", async () => {
    const { kit } = await probeRig(() => ({ mocks: { health: async () => ({ core: "OK", networks: "OK" }), urlPost: async () => ({ status: 200, reason: null }), directInvoke: async () => "AccessDeniedException" } }));
    expect(await kit.driver(probe)).toMatchObject({ ok: true, result: { refused: false } });
  });

  it("[FL-099] a change of gprobe fails the probe even when every path answered a refusal", async () => {
    const { kit } = await probeRig((rig) => ({
      janitorDirect: async () => {
        await rig.mc.connector.runtime.putClock({ worldId: PROBE_WORLD, mode: "PAUSED", pausedSimNow: "2026-10-08T10:10:00-03:00", worldEpoch: 1 }, 1);
        return { kind: "INVALID" };
      },
    }));
    const answer = await kit.driver(probe);
    expect(answer).toMatchObject({ ok: true, result: { refused: false } });
    const result = (answer as { result: { hashBefore: string; hashAfter: string } }).result;
    expect(result.hashAfter).not.toBe(result.hashBefore);
  });

  it("[FL-099] the hash covers the world's clock, timers and core rows", async () => {
    const { rig, kit } = await probeRig();
    const before = await gprobeHash(kit.ports);
    expect(await gprobeHash(kit.ports)).toBe(before);
    await rig.mc.connector.timers.put({ worldId: PROBE_WORLD, kind: "FOLLOW_UP", timerId: "x", dueAtSim: START_SIM, seq: 1, status: "SCHEDULED", epoch: 1, payload: {} });
    expect(await gprobeHash(kit.ports)).not.toBe(before);
  });

  it("[FL-099] writes nothing of its own: a probe is never remembered", async () => {
    const { rig, kit } = await probeRig();
    await kit.driver(probe);
    expect(await kit.driver(probe)).toMatchObject({ ok: true, replayed: false });
    expect(await rig.mc.connector.runtime.isAgentKilled(PROBE_WORLD)).toBe(false);
  });
});
