// ScheduleDispatch (docs/architecture.md §10): the decision from the stored timer, tombstone and clock
// (never the input), the schedule name against the fired ARN, and what each kind does where it is
// claimed: the batch publication with its rechecks, the safety-net recheck, the network transitions and
// the hand-off of the worker's kinds (the SLA milestones end to end), with `eventAtSim = dueAtSim`
// whoever fires it.
import { describe, expect, it } from "vitest";
import { TEST_NOW, complaint } from "../connector/testing";
import { linesNamed } from "../complaints/testing";
import { createScheduleDispatchHandler } from "../handlers/schedule-dispatch";
import { dispatchScheduled } from "./dispatch";
import { runTimerEvent } from "./effects";
import { fireTimer } from "./fire";
import { scheduleNameOf } from "./schedule-name";
import { START_SIM, fakeNetworks, timersKit } from "./testing";
import { NetworkClientError } from "../networks/errors";

type Kit = ReturnType<typeof timersKit>;

const ARN = (name: string) => `arn:aws:scheduler:us-east-1:776805327629:schedule/aws-cds-hackathon-poc-reclamo-poc-schedules/${name}`;
const MINUTE = 60_000;

/** The stored clock RUNNING at 1440 since TEST_NOW, for 30 real minutes. */
async function running(kit: Kit, worldId = "demo", untilMs = 30 * MINUTE): Promise<void> {
  const clock = await kit.connector.runtime.getClock(worldId);
  await kit.connector.runtime.putClock(
    { worldId, mode: "RUNNING", anchorSim: START_SIM, anchorReal: TEST_NOW.toISOString(), rate: 1_440, runningUntilReal: new Date(TEST_NOW.getTime() + untilMs).toISOString(), worldEpoch: 1 },
    clock?.version,
  );
}

function simPlus(minutes: number): string {
  return new Date(Date.parse(START_SIM) + minutes * MINUTE).toISOString();
}

function inputFor(worldId: string, kind: string, timerId: string, version = 1, epoch = 1, name?: string) {
  const timerKey = `W#${worldId}#TIMER#${kind}#${timerId}`;
  return { worldId, timerKey, version, epoch, dueAtSim: simPlus(1), scheduleArn: ARN(name ?? scheduleNameOf(worldId, epoch, timerKey)) };
}

async function withComplaint(kit: Kit, worldId = "demo", overrides: Parameters<typeof complaint>[1] = {}): Promise<void> {
  await kit.connector.transact([kit.connector.complaints.createOp(complaint(worldId, overrides))]);
}

const SLA = { kind: "SLA" as const, timerId: "cmp-0001-OPERATOR_REMINDER", payload: { milestone: "OPERATOR_REMINDER", complaintId: "cmp-0001", complaintNumber: "R-2026-000123", deadlineSim: "2026-10-22T23:59:59-03:00" } };

describe("ScheduleDispatch input and schedule name", () => {
  it("drops an input outside the schema, and a timer key of another world, without reading anything", async () => {
    const kit = timersKit();
    expect(await dispatchScheduled({ worldId: "demo" }, kit.deps)).toEqual({ status: "INVALID" });
    expect(await dispatchScheduled({ ...inputFor("demo", "SLA", "x"), timerKey: "W#g01#TIMER#SLA#x" }, kit.deps)).toEqual({ status: "INVALID" });
    expect(await dispatchScheduled({ ...inputFor("demo", "SLA", "x"), caller: "QA" }, kit.deps)).toEqual({ status: "INVALID" });
  });

  it("[FL-099] discards a fire whose ARN names another schedule (SCHEDULE_NAME_MISMATCH)", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit);
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1) });
    const result = await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId, 1, 1, scheduleNameOf("g01", 1, `W#g01#TIMER#SLA#${SLA.timerId}`)), kit.deps);
    expect(result).toEqual({ status: "SCHEDULE_NAME_MISMATCH" });
    expect((await kit.getTimer("demo", "SLA", SLA.timerId))?.status).toBe("SCHEDULED");
    expect(await kit.connector.audit.listByAction("demo", "LATE_FIRE_DISCARDED")).toEqual([expect.objectContaining({ outcome: "SCHEDULE_NAME_MISMATCH" })]);
    expect(kit.events).toEqual([]);
  });
});

describe("the Lambda entry", () => {
  it("[FL-081] validates, decides from what is stored and refuses an ARN of another group of schedules", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit);
    await withComplaint(kit);
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1) });
    const handler = createScheduleDispatchHandler(() => kit.deps, () => ({ group: "aws-cds-hackathon-poc-reclamo-poc-schedules" }), () => kit.log);
    expect(await handler("not an input")).toEqual({ status: "INVALID" });
    const input = inputFor("demo", "SLA", SLA.timerId);
    expect(await handler({ ...input, scheduleArn: input.scheduleArn.replace("poc-schedules", "other-group") })).toEqual({ status: "SCHEDULE_NAME_MISMATCH" });
    expect(await handler(input)).toEqual({ status: "TIMER_FIRED" });
  });
});

describe("late fires [FL-081]", () => {
  const cases = [
    { name: "a cancelled timer", stored: { status: "CANCELLED" as const }, version: 1, reason: "CANCELLED" },
    { name: "a timer that already fired", stored: { status: "FIRED" as const }, version: 1, reason: "ALREADY_FIRED" },
    { name: "another version", stored: {}, version: 7, reason: "STALE_VERSION" },
  ];
  for (const testCase of cases) {
    it(`[FL-081] ${testCase.name} → LATE_FIRE_DISCARDED ${testCase.reason}, audited, no effect`, async () => {
      const kit = timersKit();
      await kit.seedWorld();
      await running(kit);
      await withComplaint(kit);
      await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1), ...testCase.stored });
      const result = await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId, testCase.version), kit.deps);
      expect(result).toEqual({ status: "LATE_FIRE_DISCARDED", reason: testCase.reason });
      expect(kit.events).toEqual([]);
      expect(linesNamed(kit.lines, "timers.fire_discarded")[0]).toMatchObject({ metric: "LateFiresDiscarded", reason: testCase.reason });
      expect(await kit.connector.audit.listByAction("demo", "LATE_FIRE_DISCARDED")).toEqual([expect.objectContaining({ outcome: testCase.reason, primaryRef: "CMP#cmp-0001" })]);
    });
  }

  it("[FL-081] a schedule of a tombstoned epoch is discarded even if the reloaded timer has the same key and version", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit);
    await withComplaint(kit);
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1), epoch: 2 });
    await kit.connector.write(kit.connector.runtime.putTombstoneOp({ worldId: "demo", epoch: 1, reason: "RESET", atReal: TEST_NOW.toISOString() }));
    expect(await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId, 1, 1), kit.deps)).toEqual({ status: "LATE_FIRE_DISCARDED", reason: "TOMBSTONED" });
    expect((await kit.getTimer("demo", "SLA", SLA.timerId))?.status).toBe("SCHEDULED");
  });

  it("[FL-081] a timer that no longer exists is a stale fire", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    expect(await dispatchScheduled(inputFor("demo", "SLA", "gone"), kit.deps)).toEqual({ status: "LATE_FIRE_DISCARDED", reason: "STALE_VERSION" });
  });
});

describe("early fires [FL-081]", () => {
  it("[FL-081] [FL-099] an input fabricated with the current version of a paused world (gprobe) → EARLY_FIRE_DISCARDED CLOCK_PAUSED", async () => {
    const kit = timersKit();
    await kit.seedWorld("gprobe");
    await kit.putTimers("gprobe", { ...SLA, dueAtSim: simPlus(1) });
    const before = kit.store.dump("Timers");
    const result = await dispatchScheduled({ ...inputFor("gprobe", "SLA", SLA.timerId), dueAtSim: START_SIM }, kit.deps);
    expect(result).toEqual({ status: "EARLY_FIRE_DISCARDED", reason: "CLOCK_PAUSED" });
    expect(kit.store.dump("Timers")).toEqual(before);
    expect(linesNamed(kit.lines, "timers.fire_discarded")[0]).toMatchObject({ metric: "EarlyFiresDiscarded", reason: "CLOCK_PAUSED" });
    expect(kit.events).toEqual([]);
  });

  it("[FL-081] decides from the stored clock and timer: dueAtReal more than 90 s away is NOT_DUE whatever the input says", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit);
    // Three simulated days at 1440 are three real minutes away.
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(3 * 24 * 60) });
    const result = await dispatchScheduled({ ...inputFor("demo", "SLA", SLA.timerId), dueAtSim: START_SIM }, kit.deps);
    expect(result).toEqual({ status: "EARLY_FIRE_DISCARDED", reason: "NOT_DUE" });
    expect((await kit.getTimer("demo", "SLA", SLA.timerId))?.status).toBe("SCHEDULED");
  });

  it("[FL-081] a running world past its live window reads as paused", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit, "demo", 10 * MINUTE);
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1) });
    kit.passReal(11 * MINUTE);
    expect(await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId), kit.deps)).toEqual({ status: "EARLY_FIRE_DISCARDED", reason: "CLOCK_PAUSED" });
  });
});

describe("a Scheduler fire that runs [FL-082]", () => {
  it("[FL-082] claims the timer as SCHEDULER at its dueAtSim, even when it arrives late, and hands the worker a TIMER event", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit);
    await withComplaint(kit);
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1) });
    kit.passReal(50_000); // the Scheduler is up to a minute late: 50 s real = 50 simulated minutes
    expect(await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId), kit.deps)).toEqual({ status: "TIMER_FIRED" });
    expect(await kit.getTimer("demo", "SLA", SLA.timerId)).toMatchObject({ status: "FIRED", firedBy: "SCHEDULER", firedAtSim: simPlus(1), version: 2 });
    expect(kit.events).toEqual([
      expect.objectContaining({ type: "TIMER", worldId: "demo", customerId: "cus-0001", epoch: 1, eventAtSim: simPlus(1), payload: { kind: "SLA", timerId: SLA.timerId, version: 1, dueAtSim: simPlus(1) } }),
    ]);
    expect(await kit.connector.audit.listByAction("demo", "TIMER_FIRED")).toEqual([expect.objectContaining({ outcome: "SCHEDULER", atSim: simPlus(1) })]);
    // The same schedule delivered again finds it FIRED.
    expect(await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId), kit.deps)).toEqual({ status: "LATE_FIRE_DISCARDED", reason: "ALREADY_FIRED" });
    expect(kit.events).toHaveLength(1);
  });

  it("[FL-082] tops up the running world's schedules after a fire: the next timer gets its schedule", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await running(kit);
    await withComplaint(kit);
    await kit.putTimers("demo", { ...SLA, dueAtSim: simPlus(1) }, { ...SLA, timerId: "cmp-0001-DEADLINE", seq: 2, dueAtSim: simPlus(10 * 24 * 60), payload: { ...SLA.payload, milestone: "DEADLINE" } });
    await dispatchScheduled(inputFor("demo", "SLA", SLA.timerId), kit.deps);
    const deadline = await kit.getTimer("demo", "SLA", "cmp-0001-DEADLINE");
    expect(deadline?.scheduleName).toBe(scheduleNameOf("demo", 1, "W#demo#TIMER#SLA#cmp-0001-DEADLINE"));
    expect(kit.scheduler.live.get(deadline?.scheduleName ?? "")?.input).toMatchObject({ version: 2, epoch: 1 });
  });

  it("[FL-099] a fire in one guest world leaves the same template timer of another guest world untouched", async () => {
    const kit = timersKit();
    for (const world of ["g01", "g02"]) {
      await kit.seedWorld(world);
      await running(kit, world);
      await withComplaint(kit, world);
      await kit.putTimers(world, { ...SLA, dueAtSim: simPlus(1) });
    }
    expect(await dispatchScheduled(inputFor("g01", "SLA", SLA.timerId), kit.deps)).toEqual({ status: "TIMER_FIRED" });
    expect((await kit.getTimer("g02", "SLA", SLA.timerId))?.status).toBe("SCHEDULED");
    expect(kit.events.map((event) => event.worldId)).toEqual(["g01"]);
  });
});

describe("batch publication and rechecks [FL-017]", () => {
  const PUBLISH = { kind: "SETTLEMENT_PUBLISH" as const, timerId: "NORTE-2026-10-07", dueAtSim: "2026-10-08T08:30:00-03:00", ownerKey: "BATCH#NORTE#2026-10-07", payload: { network: "NORTE", businessDate: "2026-10-07" } };
  const RECHECK = { kind: "SETTLEMENT_RECHECK" as const, timerId: "rck-cmp-0001", dueAtSim: "2026-10-08T10:30:00-03:00", ownerKey: "BATCH#NORTE#2026-10-07", seq: 1, payload: { complaintId: "cmp-0001" } };

  it("[FL-017] the publication fires the batch's rechecks (PUBLICATION, at 08:30) and enqueues SETTLEMENT_PUBLISHED in the same dispatch", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await withComplaint(kit, "demo", { status: "AWAITING_SETTLEMENT" });
    await kit.putTimers("demo", PUBLISH, RECHECK);
    const timer = await kit.getTimer("demo", "SETTLEMENT_PUBLISH", PUBLISH.timerId);
    const outcome = await fireTimer({ timer: timer!, firedBy: "CLOCK" }, kit.deps);
    expect(outcome).toMatchObject({ status: "FIRED", effect: { alsoFired: ["rck-cmp-0001"] } });
    expect(kit.networks.calls).toEqual([{ op: "publish", worldId: "demo", simNow: PUBLISH.dueAtSim, args: ["NORTE", "2026-10-07"] }]);
    expect(await kit.getTimer("demo", "SETTLEMENT_RECHECK", RECHECK.timerId)).toMatchObject({ status: "FIRED", firedBy: "PUBLICATION", firedAtSim: PUBLISH.dueAtSim });
    expect(kit.events).toEqual([
      expect.objectContaining({ type: "SETTLEMENT_PUBLISHED", customerId: "cus-0001", eventAtSim: PUBLISH.dueAtSim, payload: { complaintId: "cmp-0001", batchKey: "BATCH#NORTE#2026-10-07" } }),
    ]);
    expect(await kit.connector.timers.listDue("demo")).toEqual([]);
  });

  it("[FL-017] a complaint that no longer waits for the batch gets nothing", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await withComplaint(kit, "demo", { status: "INVESTIGATING" });
    await kit.putTimers("demo", PUBLISH, RECHECK);
    await fireTimer({ timer: (await kit.getTimer("demo", "SETTLEMENT_PUBLISH", PUBLISH.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(kit.events).toEqual([]);
    expect((await kit.getTimer("demo", "SETTLEMENT_RECHECK", RECHECK.timerId))?.status).toBe("FIRED");
  });

  it("[FL-017] a publication the network defers leaves a new SETTLEMENT_PUBLISH timer at the new instant and fires no recheck", async () => {
    const kit = timersKit({ networks: fakeNetworks({ deferTo: "2026-10-08T10:00:00-03:00" }) });
    await kit.seedWorld();
    await withComplaint(kit, "demo", { status: "AWAITING_SETTLEMENT" });
    await kit.putTimers("demo", PUBLISH, RECHECK);
    const outcome = await fireTimer({ timer: (await kit.getTimer("demo", "SETTLEMENT_PUBLISH", PUBLISH.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(outcome).toMatchObject({ status: "FIRED", effect: { note: "DEFERRED_BY_NETWORK" } });
    expect(await kit.getTimer("demo", "SETTLEMENT_PUBLISH", "NORTE-2026-10-07-r1")).toMatchObject({ status: "SCHEDULED", dueAtSim: "2026-10-08T10:00:00-03:00", ownerKey: PUBLISH.ownerKey });
    expect((await kit.getTimer("demo", "SETTLEMENT_RECHECK", RECHECK.timerId))?.status).toBe("SCHEDULED");
    expect(kit.events).toEqual([]);
  });

  it("[FL-017] the safety-net recheck alone enqueues SETTLEMENT_PUBLISHED for its waiting complaint", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await withComplaint(kit, "demo", { status: "AWAITING_SETTLEMENT" });
    await kit.putTimers("demo", RECHECK);
    await fireTimer({ timer: (await kit.getTimer("demo", "SETTLEMENT_RECHECK", RECHECK.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(kit.events).toEqual([expect.objectContaining({ type: "SETTLEMENT_PUBLISHED", eventAtSim: RECHECK.dueAtSim, payload: { complaintId: "cmp-0001", batchKey: "BATCH#NORTE#2026-10-07" } })]);
  });

  it("a dispatch whose effect fails undoes its claim (due again), audits it and enqueues nothing", async () => {
    const kit = timersKit({ networks: fakeNetworks({ fail: new NetworkClientError("UNAVAILABLE", "down", { attempts: 4 }) }) });
    await kit.seedWorld();
    await kit.putTimers("demo", PUBLISH);
    const outcome = await fireTimer({ timer: (await kit.getTimer("demo", "SETTLEMENT_PUBLISH", PUBLISH.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(outcome).toEqual({ status: "FAILED", errorName: "NetworkClientError" });
    expect(await kit.getTimer("demo", "SETTLEMENT_PUBLISH", PUBLISH.timerId)).toMatchObject({ status: "SCHEDULED", version: 3 });
    expect(await kit.connector.timers.listDue("demo")).toHaveLength(1);
    expect(linesNamed(kit.lines, "timers.dispatch_failed")[0]).toMatchObject({ metric: "TimerDispatchFailures" });
    expect(await kit.connector.audit.listByAction("demo", "TIMER_DISPATCH_FAILED")).toHaveLength(1);
  });
});

describe("network transitions [FL-042] [FL-047]", () => {
  const TRANSFER = { kind: "NETWORK_TRANSITION" as const, timerId: "trf-0028-1", dueAtSim: "2026-10-08T12:00:00-03:00", ownerKey: "TRF#trf-0028-1", payload: { transferId: "trf-0028-1", to: "COMPLETED" } };
  const DISBURSEMENT = { kind: "NETWORK_TRANSITION" as const, timerId: "dsb-0033", dueAtSim: "2026-10-09T15:00:00-03:00", ownerKey: "LOAN#L-0033", payload: { loanId: "L-0033", to: "CREDITED" } };

  it("[FL-042] the transfer changes in the network at its dueAtSim and the complaint waiting for it gets TRANSFER_STATUS_CHANGED", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await withComplaint(kit, "demo", { complaintId: "cmp-0028", customerId: "cus-0028", status: "AWAITING_NETWORK", type: "TRANSFER_NOT_CREDITED", subject: { transferId: "trf-0028-1" } });
    await withComplaint(kit, "demo", { complaintId: "cmp-0029", complaintNumber: "R-2026-000124", customerId: "cus-0029", status: "INVESTIGATING", subject: { transferId: "trf-0028-1" } });
    await kit.putTimers("demo", TRANSFER);
    await fireTimer({ timer: (await kit.getTimer("demo", "NETWORK_TRANSITION", TRANSFER.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(kit.networks.calls).toEqual([{ op: "transition", worldId: "demo", simNow: TRANSFER.dueAtSim, args: ["trf-0028-1", { to: "COMPLETED" }] }]);
    expect(kit.events).toEqual([
      expect.objectContaining({ type: "TRANSFER_STATUS_CHANGED", customerId: "cus-0028", eventAtSim: TRANSFER.dueAtSim, payload: { complaintId: "cmp-0028", transferId: "trf-0028-1" } }),
    ]);
  });

  it("[FL-042] a transfer the network already moved another way (CONFLICT) changes nothing else", async () => {
    const kit = timersKit({ networks: fakeNetworks({ transition: () => new NetworkClientError("CONFLICT", "moved", { attempts: 1, status: 409 }) }) });
    await kit.seedWorld();
    await withComplaint(kit, "demo", { status: "AWAITING_NETWORK", subject: { transferId: "trf-0028-1" } });
    await kit.putTimers("demo", TRANSFER);
    const outcome = await fireTimer({ timer: (await kit.getTimer("demo", "NETWORK_TRANSITION", TRANSFER.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(outcome).toMatchObject({ status: "FIRED", effect: { note: "NETWORK_CONFLICT" } });
    expect(kit.events).toEqual([]);
  });

  it("[FL-047] a disbursement's state comes from the core's simulated day: no network call, the waiting complaint gets its event", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await withComplaint(kit, "demo", { complaintId: "cmp-0033", customerId: "cus-0033", status: "AWAITING_NETWORK", type: "DISBURSEMENT_NOT_RECEIVED", subject: { loanId: "L-0033" } });
    await kit.putTimers("demo", DISBURSEMENT);
    await fireTimer({ timer: (await kit.getTimer("demo", "NETWORK_TRANSITION", DISBURSEMENT.timerId))!, firedBy: "CLOCK" }, kit.deps);
    expect(kit.networks.calls).toEqual([]);
    expect(kit.events).toEqual([expect.objectContaining({ type: "TRANSFER_STATUS_CHANGED", customerId: "cus-0033", payload: { complaintId: "cmp-0033" } })]);
  });

  it("[FL-047] a FOLLOW_UP fires as a TIMER event for the worker's follow-up turn, at its dueAtSim", async () => {
    const kit = timersKit();
    await kit.seedWorld();
    await withComplaint(kit, "demo", { complaintId: "cmp-0033", customerId: "cus-0033", status: "AWAITING_NETWORK" });
    await kit.putTimers("demo", { kind: "FOLLOW_UP", timerId: "cmp-0033-FOLLOW-1", dueAtSim: "2026-10-09T16:00:00-03:00", ownerKey: "CMP#cmp-0033", payload: { complaintId: "cmp-0033" } });
    await fireTimer({ timer: (await kit.getTimer("demo", "FOLLOW_UP", "cmp-0033-FOLLOW-1"))!, firedBy: "CLOCK" }, kit.deps);
    expect(kit.events).toEqual([expect.objectContaining({ type: "TIMER", customerId: "cus-0033", eventAtSim: "2026-10-09T16:00:00-03:00", payload: expect.objectContaining({ kind: "FOLLOW_UP" }) })]);
  });
});

describe("SLA milestones, deterministic and without a turn [FL-077] [FL-078] [FL-079]", () => {
  async function fireMilestone(kit: Kit, milestone: "OPERATOR_REMINDER" | "SUPERVISOR_ESCALATION" | "DEADLINE", worldId = "demo", origin: "LIVE" | "SEED" = "LIVE") {
    await kit.seedWorld(worldId);
    await withComplaint(kit, worldId, { status: "HUMAN_REVIEW", origin });
    const timerId = `cmp-0001-${milestone}`;
    await kit.putTimers(worldId, { ...SLA, timerId, dueAtSim: "2026-10-15T10:00:00-03:00", payload: { ...SLA.payload, milestone } });
    await fireTimer({ timer: (await kit.getTimer(worldId, "SLA", timerId))!, firedBy: "CLOCK" }, kit.deps);
    const [event] = kit.timerEvents();
    return runTimerEvent(event!, kit.effectDeps());
  }

  it("[FL-077] OPERATOR_REMINDER: a note on the case and AuditLog SLA_REMINDER; no message, no state change", async () => {
    const kit = timersKit();
    expect(await fireMilestone(kit, "OPERATOR_REMINDER")).toEqual({ status: "DONE", action: "SLA_REMINDER" });
    expect((await kit.getTimer("demo", "SLA", "cmp-0001-OPERATOR_REMINDER"))?.status).toBe("FIRED");
    const notes = await kit.connector.caseItems.listNotes("demo", "cmp-0001");
    expect(notes).toEqual([expect.objectContaining({ kind: "SLA", author: "SYSTEM", atSim: "2026-10-15T10:00:00-03:00", text: "Recordatorio: el reclamo R-2026-000123 está en el día hábil 5 de 10. Vence el jueves 22/10." })]);
    expect(await kit.connector.audit.listByAction("demo", "SLA_REMINDER")).toHaveLength(1);
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.slaState).toBe("ON_TIME");
    expect(kit.gateCalls).toEqual([]);
  });

  it("[FL-078] SUPERVISOR_ESCALATION: AT_RISK, AuditLog SUPERVISOR_ALERT and the alert email only in the world demo", async () => {
    const kit = timersKit();
    expect(await fireMilestone(kit, "SUPERVISOR_ESCALATION")).toEqual({ status: "DONE", action: "SUPERVISOR_ALERT" });
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.slaState).toBe("AT_RISK");
    expect(await kit.connector.audit.listByAction("demo", "SUPERVISOR_ALERT")).toHaveLength(1);
    expect(kit.alerts).toEqual([{ worldId: "demo", complaintId: "cmp-0001", complaintNumber: "R-2026-000123", deadlineSim: "2026-10-22T23:59:59-03:00" }]);
    const guest = timersKit();
    await fireMilestone(guest, "SUPERVISOR_ESCALATION", "g01");
    expect((await guest.connector.complaints.get("g01", "cmp-0001"))?.slaState).toBe("AT_RISK");
    expect(guest.alerts).toEqual([]);
    expect(guest.gateCalls).toEqual([]);
  });

  it("[FL-079] DEADLINE: OVERDUE and the SlaOverdue metric for a live complaint, not for a seeded one", async () => {
    const kit = timersKit();
    expect(await fireMilestone(kit, "DEADLINE")).toEqual({ status: "DONE", action: "SLA_OVERDUE" });
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.slaState).toBe("OVERDUE");
    expect(linesNamed(kit.lines, "timers.sla_overdue")).toEqual([expect.objectContaining({ metric: "SlaOverdue", worldId: "demo" })]);
    const seeded = timersKit();
    await fireMilestone(seeded, "DEADLINE", "demo", "SEED");
    expect((await seeded.connector.complaints.get("demo", "cmp-0001"))?.slaState).toBe("OVERDUE");
    expect(linesNamed(seeded.lines, "timers.sla_overdue")).toEqual([]);
  });

  it("[FL-077] a redelivered TIMER event writes nothing twice", async () => {
    const kit = timersKit();
    await fireMilestone(kit, "OPERATOR_REMINDER");
    const [event] = kit.timerEvents();
    expect(await runTimerEvent(event!, kit.effectDeps())).toEqual({ status: "SKIPPED", reason: "ALREADY_APPLIED" });
    expect(await kit.connector.caseItems.listNotes("demo", "cmp-0001")).toHaveLength(1);
  });
});
