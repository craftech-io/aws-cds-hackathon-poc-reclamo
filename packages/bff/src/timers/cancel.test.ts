// schedule_sla_milestones and cancel_milestones over the Scheduler (docs/architecture.md §8.4 and §10):
// a complaint registered in a running world gets its milestones' schedules after the commit; the
// written answer (or a withdrawal) cancels the three timers with version + 1 and deletes their
// schedules, and a schedule that fires anyway finds its timer CANCELLED (FL-080).
import { describe, expect, it } from "vitest";
import { SIM_NOW, complaint, worldSettings } from "../connector/testing";
import { registerComplaint } from "../complaints/numbering";
import { milestoneTimers, slaPlan } from "../complaints/sla";
import { transition, withdraw } from "../complaints/state-machine";
import { TEST_HOLIDAYS } from "../complaints/testing";
import type { ComplaintsDeps } from "../complaints/deps";
import { pause, setRunning } from "../clock/running";
import { dispatchScheduled } from "./dispatch";
import { timerMilestoneScheduler } from "./milestones";
import { scheduleNameOf } from "./schedule-name";
import { timersKit } from "./testing";

type Kit = ReturnType<typeof timersKit>;

const ARN = (name: string) => `arn:aws:scheduler:us-east-1:776805327629:schedule/aws-cds-hackathon-poc-reclamo-poc-schedules/${name}`;
const MILESTONES = ["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"] as const;

async function world(kit: Kit, mode: "PAUSED" | "RUNNING"): Promise<ComplaintsDeps> {
  await kit.seedWorld("demo", SIM_NOW);
  await kit.connector.worlds.putSettings(worldSettings("demo"));
  if (mode === "RUNNING") await setRunning({ worldId: "demo", rate: 1_440, caller: { actor: "SYSTEM" } }, kit.deps);
  return { ...kit.effectDeps().complaints, milestones: timerMilestoneScheduler(kit.deps) };
}

/** A resolved complaint with its written answer sent and its three milestones (scheduled when running). */
async function answeredReady(kit: Kit, deps: ComplaintsDeps): Promise<void> {
  const base = complaint("demo", { status: "RESOLVED", answer: { messageId: "msg-0009", mailId: "mail-0009", sentAtSim: SIM_NOW, deliveryProof: "SENT" } });
  const timers = milestoneTimers({ worldId: "demo", epoch: 1, complaintId: "cmp-0001", complaintNumber: base.complaintNumber, plan: slaPlan(SIM_NOW, TEST_HOLIDAYS) });
  await kit.connector.transact([kit.connector.complaints.createOp(base), ...timers.map((timer) => kit.connector.timers.putOp(timer))]);
  await deps.milestones?.schedule("demo", timers);
}

describe("schedule_sla_milestones", () => {
  it("[FL-080] a complaint registered in a running world gets one schedule per milestone, named per world and epoch", async () => {
    const kit = timersKit();
    const deps = await world(kit, "RUNNING");
    const registration = await registerComplaint(deps, {
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
    const id = registration.complaint.complaintId;
    const names = MILESTONES.map((milestone) => scheduleNameOf("demo", 1, `W#demo#TIMER#SLA#${id}-${milestone}`));
    expect([...kit.scheduler.live.keys()].sort()).toEqual([...names].sort());
    for (const milestone of MILESTONES) expect((await kit.getTimer("demo", "SLA", `${id}-${milestone}`))?.scheduleName).toBe(scheduleNameOf("demo", 1, `W#demo#TIMER#SLA#${id}-${milestone}`));
  });

  it("[FL-080] a paused world gets no schedule at all", async () => {
    const kit = timersKit();
    const deps = await world(kit, "PAUSED");
    await answeredReady(kit, deps);
    expect(kit.scheduler.puts).toEqual([]);
  });
});

describe("cancel_milestones [FL-080]", () => {
  it("[FL-080] the written answer cancels the three timers (version + 1) and deletes their schedules; AUTO_CLOSE takes over", async () => {
    const kit = timersKit();
    const deps = await world(kit, "RUNNING");
    await answeredReady(kit, deps);
    const before = await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001");
    const named = before.flatMap((timer) => (timer.scheduleName ? [timer.scheduleName] : []));
    expect(named).toHaveLength(3);

    await transition(deps, { worldId: "demo", complaintId: "cmp-0001", to: "ANSWERED", cause: "ANSWER_SENT", actor: "SYSTEM", atSim: SIM_NOW, holidays: TEST_HOLIDAYS });

    const after = await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001");
    for (const timer of after.filter((item) => item.kind === "SLA")) {
      const previous = before.find((item) => item.timerId === timer.timerId);
      expect(timer).toMatchObject({ status: "CANCELLED", reason: "ANSWERED", version: (previous?.version ?? 0) + 1 });
    }
    expect(kit.scheduler.deletes).toEqual(expect.arrayContaining(named));
    for (const name of named) expect(kit.scheduler.live.has(name)).toBe(false);
    expect(after.filter((item) => item.status === "SCHEDULED").map((item) => item.kind)).toEqual(["AUTO_CLOSE"]);
  });

  it("[FL-080] a milestone's schedule that fires after the cancellation finds its timer CANCELLED", async () => {
    const kit = timersKit();
    const deps = await world(kit, "RUNNING");
    await answeredReady(kit, deps);
    const reminder = await kit.getTimer("demo", "SLA", "cmp-0001-OPERATOR_REMINDER");
    await transition(deps, { worldId: "demo", complaintId: "cmp-0001", to: "ANSWERED", cause: "ANSWER_SENT", actor: "SYSTEM", atSim: SIM_NOW, holidays: TEST_HOLIDAYS });
    const timerKey = "W#demo#TIMER#SLA#cmp-0001-OPERATOR_REMINDER";
    const result = await dispatchScheduled({ worldId: "demo", timerKey, version: reminder!.version, epoch: 1, dueAtSim: reminder!.dueAtSim, scheduleArn: ARN(reminder!.scheduleName!) }, kit.deps);
    expect(result).toEqual({ status: "LATE_FIRE_DISCARDED", reason: "CANCELLED" });
    expect(kit.events).toEqual([]);
  });

  it("[FL-080] a withdrawal cancels them too, with their schedules", async () => {
    const kit = timersKit();
    const deps = await world(kit, "RUNNING");
    await answeredReady(kit, deps);
    const named = (await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001")).flatMap((timer) => (timer.scheduleName ? [timer.scheduleName] : []));
    await withdraw(deps, { worldId: "demo", complaintId: "cmp-0001", cause: "CUSTOMER_WITHDREW", actor: "AGENT", atSim: SIM_NOW, holidays: TEST_HOLIDAYS });
    const sla = (await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001")).filter((item) => item.kind === "SLA");
    expect(sla.map((item) => [item.status, item.reason])).toEqual([
      ["CANCELLED", "WITHDRAWN"],
      ["CANCELLED", "WITHDRAWN"],
      ["CANCELLED", "WITHDRAWN"],
    ]);
    for (const name of named) expect(kit.scheduler.live.has(name)).toBe(false);
  });

  it("[FL-080] cancelling after the world paused deletes nothing twice and leaves no schedule", async () => {
    const kit = timersKit();
    const deps = await world(kit, "RUNNING");
    await answeredReady(kit, deps);
    await pause({ worldId: "demo", caller: { actor: "SYSTEM" } }, kit.deps);
    expect(kit.scheduler.live.size).toBe(0);
    await transition(deps, { worldId: "demo", complaintId: "cmp-0001", to: "ANSWERED", cause: "ANSWER_SENT", actor: "SYSTEM", atSim: SIM_NOW, holidays: TEST_HOLIDAYS });
    const sla = (await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001")).filter((item) => item.kind === "SLA");
    expect(sla.every((item) => item.status === "CANCELLED")).toBe(true);
    expect(kit.scheduler.live.size).toBe(0);
  });
});
