// The regulatory clock (docs/architecture.md §8.4, docs/design-brief.md §6): deadline with holidays,
// three milestone timers at registration, their cancellation with the answer, `AUTO_CLOSE`.
import { describe, expect, it } from "vitest";
import { SIM_NOW, timer } from "../connector/testing";
import { registerComplaint } from "./numbering";
import { autoCloseAt, cancelMilestonesPlan, deadlineText, isoAr, loadHolidays, milestoneTimers, slaPlan, slaStateAt } from "./sla";
import { TEST_HOLIDAYS, complaintsKit } from "./testing";

describe("deadline and milestones [FL-076]", () => {
  it("[FL-076] a complaint filed Wednesday 07/10 is due Thursday 22/10 23:59:59 (Monday 12/10 does not count)", () => {
    const plan = slaPlan(SIM_NOW, TEST_HOLIDAYS);
    expect(plan.deadlineSim).toBe("2026-10-22T23:59:59-03:00");
    expect(plan.milestones).toEqual([
      { milestone: "OPERATOR_REMINDER", dueAtSim: "2026-10-15T10:00:00-03:00" },
      { milestone: "SUPERVISOR_ESCALATION", dueAtSim: "2026-10-20T10:00:00-03:00" },
      { milestone: "DEADLINE", dueAtSim: "2026-10-22T23:59:59-03:00" },
    ]);
    expect(deadlineText(plan.deadlineSim)).toBe("jueves 22/10");
  });

  it("[FL-076] without the holiday the same filing would be due a day earlier", () => {
    expect(slaPlan(SIM_NOW, []).deadlineSim).toBe("2026-10-21T23:59:59-03:00");
  });

  it("writes instants in Argentine local time with their offset", () => {
    expect(isoAr(new Date("2026-10-23T02:59:59.000Z"))).toBe("2026-10-22T23:59:59-03:00");
    expect(deadlineText("2026-11-24T02:59:59Z")).toBe("lunes 23/11");
  });

  it("[FL-076] builds the three milestone timers of a complaint, owned by it, in order", () => {
    const timers = milestoneTimers({ worldId: "demo", epoch: 1, complaintId: "cmp-0001", complaintNumber: "R-2026-000123", plan: slaPlan(SIM_NOW, TEST_HOLIDAYS) });
    expect(timers.map((item) => [item.kind, item.timerId, item.seq, item.status, item.ownerKey])).toEqual([
      ["SLA", "cmp-0001-OPERATOR_REMINDER", 0, "SCHEDULED", "CMP#cmp-0001"],
      ["SLA", "cmp-0001-SUPERVISOR_ESCALATION", 1, "SCHEDULED", "CMP#cmp-0001"],
      ["SLA", "cmp-0001-DEADLINE", 2, "SCHEDULED", "CMP#cmp-0001"],
    ]);
  });

  it("[FL-076] registration leaves the three timers SCHEDULED in ClockDue, without a schedule while the world is paused", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const registration = await registerComplaint(kit.deps, {
      worldId: "demo",
      customerId: "cus-0001",
      kind: "RECLAMO",
      type: "PAYMENT_NOT_REFLECTED",
      channel: "WHATSAPP",
      summary: "Pago no reflejado",
      eventId: "evt-0001",
      presenter: { docType: "DNI", docNumberMasked: "••••4417" },
      filedAtSim: SIM_NOW,
      holidays: TEST_HOLIDAYS,
      actor: "SYSTEM",
    });
    const due = await kit.connector.timers.listDue("demo");
    expect(due.map((item) => [item.timerId, item.dueAtSim, item.scheduleName])).toEqual([
      [`${registration.complaint.complaintId}-OPERATOR_REMINDER`, "2026-10-15T10:00:00-03:00", undefined],
      [`${registration.complaint.complaintId}-SUPERVISOR_ESCALATION`, "2026-10-20T10:00:00-03:00", undefined],
      [`${registration.complaint.complaintId}-DEADLINE`, "2026-10-22T23:59:59-03:00", undefined],
    ]);
  });
});

describe("cancel_milestones [FL-080]", () => {
  it("[FL-080] marks every scheduled milestone CANCELLED with version + 1 and returns the schedules to delete", async () => {
    const kit = complaintsKit();
    const owner = "CMP#cmp-0001";
    await kit.connector.transact([
      kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-OPERATOR_REMINDER", dueAtSim: "2026-10-15T10:00:00-03:00", ownerKey: owner, scheduleName: "tm-demo-e1-aaaa" })),
      kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-SUPERVISOR_ESCALATION", dueAtSim: "2026-10-20T10:00:00-03:00", ownerKey: owner, seq: 1 })),
      kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-DEADLINE", ownerKey: owner, seq: 2, status: "FIRED" })),
      kit.connector.timers.putOp(timer("demo", { kind: "FOLLOW_UP", timerId: "cmp-0001-FOLLOW", ownerKey: owner })),
    ]);
    const plan = await cancelMilestonesPlan(kit.connector, "demo", "cmp-0001", "ANSWERED");
    expect(plan.timerIds.sort()).toEqual(["cmp-0001-OPERATOR_REMINDER", "cmp-0001-SUPERVISOR_ESCALATION"]);
    expect(plan.scheduleNames).toEqual(["tm-demo-e1-aaaa"]);
    await kit.connector.transact(plan.ops);
    const after = await kit.connector.timers.listByOwner("demo", owner);
    expect(after.map((item) => [item.timerId, item.status, item.version, item.reason])).toEqual(
      expect.arrayContaining([
        ["cmp-0001-OPERATOR_REMINDER", "CANCELLED", 2, "ANSWERED"],
        ["cmp-0001-SUPERVISOR_ESCALATION", "CANCELLED", 2, "ANSWERED"],
        ["cmp-0001-DEADLINE", "FIRED", 1, undefined],
        ["cmp-0001-FOLLOW", "SCHEDULED", 1, undefined],
      ]),
    );
    expect(await kit.connector.timers.listDue("demo")).toEqual([expect.objectContaining({ timerId: "cmp-0001-FOLLOW" })]);
  });

  it("[FL-080] a timer that fired between the read and the commit makes the cancellation collide (re-read and retry)", async () => {
    const kit = complaintsKit();
    await kit.connector.transact([kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-DEADLINE" }))]);
    const plan = await cancelMilestonesPlan(kit.connector, "demo", "cmp-0001", "WITHDRAWN");
    await kit.connector.timers.transition({ worldId: "demo", kind: "SLA", timerId: "cmp-0001-DEADLINE", version: 1, from: ["SCHEDULED"], to: "FIRED", firedBy: "CLOCK" });
    await expect(kit.connector.transact(plan.ops)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("SLA state, auto close and holidays", () => {
  const filed = { filedAtSim: SIM_NOW, deadlineSim: "2026-10-22T23:59:59-03:00", holidays: TEST_HOLIDAYS };

  it("is on time until the supervisor milestone, at risk after it and overdue past the deadline", () => {
    expect(slaStateAt({ ...filed, simNow: "2026-10-20T09:59:00-03:00" })).toBe("ON_TIME");
    expect(slaStateAt({ ...filed, simNow: "2026-10-20T10:00:00-03:00" })).toBe("AT_RISK");
    expect(slaStateAt({ ...filed, simNow: "2026-10-23T00:00:00-03:00" })).toBe("OVERDUE");
    expect(slaStateAt({ ...filed, simNow: "2026-11-01T00:00:00-03:00", answeredAtSim: "2026-10-21T12:00:00-03:00" })).toBe("ON_TIME");
    expect(slaStateAt({ ...filed, simNow: "2026-11-01T00:00:00-03:00", answeredAtSim: "2026-10-23T12:00:00-03:00" })).toBe("OVERDUE");
  });

  it("closes five business days after the answer, at the same local time", () => {
    expect(autoCloseAt("2026-10-08T15:00:00-03:00", TEST_HOLIDAYS)).toBe("2026-10-16T15:00:00-03:00");
  });

  it("reads the holidays from Reference/HOLIDAY#AR", async () => {
    const kit = complaintsKit();
    for (const date of ["2026-12-25", "2026-10-12"]) await kit.store.write({ kind: "put", table: "Reference", item: { pk: "REF#HOLIDAY#AR", sk: date, date, entity: "Holiday" } });
    expect(await loadHolidays(kit.connector)).toEqual(["2026-10-12", "2026-12-25"]);
  });
});
