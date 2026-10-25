// The worker's half of `fire_timer` (docs/architecture.md §7 `TIMER`): the automatic close, the second
// evaluation of a deferred send, the follow-up turn, and the claim check every TIMER event passes.
import { describe, expect, it } from "vitest";
import { complaint } from "../connector/testing";
import { autoCloseAt } from "../complaints/sla";
import { runTimerEvent } from "./effects";
import { fireTimer } from "./fire";
import { timersKit } from "./testing";

type Kit = ReturnType<typeof timersKit>;

async function fired(kit: Kit, timer: Parameters<Kit["putTimers"]>[1]) {
  await kit.putTimers("demo", timer);
  await fireTimer({ timer: (await kit.getTimer("demo", timer.kind!, timer.timerId!))!, firedBy: "CLOCK" }, kit.deps);
  const event = kit.timerEvents().at(-1);
  if (!event) throw new Error("no TIMER event");
  return event;
}

const ANSWERED_AT = "2026-10-08T15:00:00-03:00";

describe("AUTO_CLOSE", () => {
  it("closes an answered complaint five business days after the answer", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "ANSWERED", answer: { messageId: "msg-0009", sentAtSim: ANSWERED_AT, deliveryProof: "DELIVERED" } }))]);
    const event = await fired(kit, { kind: "AUTO_CLOSE", timerId: "cmp-0001-AUTO_CLOSE-1", dueAtSim: autoCloseAt(ANSWERED_AT, []), payload: { complaintId: "cmp-0001" } });
    expect(await runTimerEvent(event, kit.effectDeps())).toEqual({ status: "DONE", action: "AUTO_CLOSED" });
    const closed = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.statusHistory.at(-1)).toMatchObject({ from: "ANSWERED", to: "CLOSED", cause: "AUTO_CLOSE", actor: "SYSTEM", atSim: autoCloseAt(ANSWERED_AT, []) });
  });

  it("leaves a complaint that moved on since the answer", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "HUMAN_REVIEW" }))]);
    const event = await fired(kit, { kind: "AUTO_CLOSE", timerId: "cmp-0001-AUTO_CLOSE-1", dueAtSim: autoCloseAt(ANSWERED_AT, []), payload: { complaintId: "cmp-0001" } });
    expect(await runTimerEvent(event, kit.effectDeps())).toEqual({ status: "SKIPPED", reason: "COMPLAINT_HUMAN_REVIEW" });
  });
});

describe("DEFERRED_SEND", () => {
  const request = { worldId: "demo", customerId: "cus-0001", sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_UPDATE", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"] }, refs: { complaintId: "cmp-0001" } };

  it("sends the kept request through the gate again, with the actor that asked for it", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    const event = await fired(kit, { kind: "DEFERRED_SEND", timerId: "dfr-0001", dueAtSim: "2026-10-08T08:00:00-03:00", ownerKey: "CONV#cus-0001", payload: { customerId: "cus-0001", request, actor: "AGENT" } });
    expect(event.customerId).toBe("cus-0001");
    expect(await runTimerEvent(event, kit.effectDeps())).toEqual({ status: "DONE", action: "DEFERRED_SEND_ALLOWED" });
    expect(kit.gateCalls).toHaveLength(1);
    expect(kit.gateCalls[0]?.request).toMatchObject({ ...request, refs: { complaintId: "cmp-0001", deferredTimerId: "dfr-0001" } });
    expect(kit.gateCalls[0]?.call.actor).toBe("AGENT");
  });

  it("refuses a kept request for another customer or world without calling the gate", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    const event = await fired(kit, { kind: "DEFERRED_SEND", timerId: "dfr-0002", dueAtSim: "2026-10-08T08:00:00-03:00", payload: { customerId: "cus-0001", request: { ...request, customerId: "cus-0002" }, actor: "AGENT" } });
    expect(await runTimerEvent(event, kit.effectDeps())).toEqual({ status: "SKIPPED", reason: "DEFERRED_REQUEST_INVALID" });
    expect(kit.gateCalls).toEqual([]);
  });

  it("reports a second deferral from the gate as such", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    const event = await fired(kit, { kind: "DEFERRED_SEND", timerId: "dfr-0003", dueAtSim: "2026-10-08T07:00:00-03:00", payload: { customerId: "cus-0001", request, actor: "SYSTEM" } });
    const deps = kit.effectDeps({ ok: true, decision: "DEFERRED", messageId: "msg-1", ruleIds: ["CH-CONTACT-HOURS"], nextAllowedAt: "2026-10-08T08:00:00-03:00", timerKey: "W#demo#TIMER#DEFERRED_SEND#dfr-0004" });
    expect(await runTimerEvent(event, deps)).toEqual({ status: "DONE", action: "DEFERRED_SEND_DEFERRED" });
  });
});

describe("FOLLOW_UP [FL-047]", () => {
  it("[FL-047] asks the worker for the follow-up turn of its complaint", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "AWAITING_NETWORK" }))]);
    const event = await fired(kit, { kind: "FOLLOW_UP", timerId: "cmp-0001-FOLLOW-1", dueAtSim: "2026-10-09T16:00:00-03:00", payload: { complaintId: "cmp-0001" } });
    expect(await runTimerEvent(event, kit.effectDeps())).toEqual({ status: "TURN", reason: "FOLLOW_UP", complaintId: "cmp-0001" });
  });
});

describe("the claim behind a TIMER event", () => {
  it("discards an event whose claim no longer stands (another version, another epoch)", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "AWAITING_NETWORK" }))]);
    const event = await fired(kit, { kind: "FOLLOW_UP", timerId: "cmp-0001-FOLLOW-1", dueAtSim: "2026-10-09T16:00:00-03:00", payload: { complaintId: "cmp-0001" } });
    expect(await runTimerEvent({ ...event, payload: { ...event.payload, version: 5 } }, kit.effectDeps())).toEqual({ status: "DISCARDED", reason: "STALE_EVENT" });
    expect(await runTimerEvent({ ...event, epoch: 2 }, kit.effectDeps())).toEqual({ status: "DISCARDED", reason: "STALE_EVENT" });
    expect(await runTimerEvent({ ...event, payload: { ...event.payload, timerId: "missing" } }, kit.effectDeps())).toEqual({ status: "DISCARDED", reason: "STALE_EVENT" });
  });
});
