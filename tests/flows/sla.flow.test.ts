// Local flows of the regulatory clock (docs/flows-catalog.md area J): the deadline and the three
// milestones written with the complaint, each milestone a timer the world clock fires by itself
// (reminder, supervisor escalation, deadline), the written answer cancelling them, and the automatic
// closure five business days after the answer, rescheduled when the customer writes about it.
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { answerChallenge, askChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type PlanSource, type PlannedCall } from "./support/scripted-harness";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const TRANSFER = "Hice una transferencia y no le llegó a la otra persona";
const REVIEW = "¿Lo pueden revisar?";
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });


/** C27's completed transfer: the agent asks the challenge, verifies the answer, reads it, resolves and answers in writing. */
function answering(): PlanSource {
  return (turn) =>
    turn.inbound === REVIEW
      ? [askChallenge]
      : repliesToChallenge(turn)
      ? [
          verifyWritten,
          { tool: "list_operations" },
          { tool: "get_transfer_status", input: { transferId: "trf-0027-1" } },
          { tool: "update_complaint", input: { status: "RESOLVED", outcome: "INFORMATIONAL" } },
          { tool: "answer_complaint_in_writing", input: { outcome: "INFORMATIONAL", draftBody: "Revisamos con la red el estado de la transferencia que nos consultaste." } },
        ]
      : [reply("Recibí tu reclamo.")];
}

async function file(world: FlowWorld, customerId = "cus-0027"): Promise<Complaint> {
  world.harness.script(() => [reply("Recibí tu reclamo.")]);
  await world.phone(customerId, { type: "text", text: TRANSFER });
  const complaint = (await world.connector.complaints.listByCustomer("demo", customerId)).find((candidate) => candidate.origin === "LIVE");
  if (complaint === undefined) throw new Error("the complaint was not filed");
  return complaint;
}

async function milestones(world: FlowWorld, complaint: Complaint) {
  return (await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).filter((timer) => timer.kind === "SLA");
}

const current = (world: FlowWorld, complaint: Complaint) => world.connector.complaints.get("demo", complaint.complaintId);

describe("[FL-076] the deadline with holidays and three milestones at filing", () => {
  it("[FL-076] filed on Wednesday 07/10, the deadline is Thursday 22/10 23:59:59 (Monday 12/10 does not count); three SCHEDULED milestones and no schedule while the clock is paused", async () => {
    const world = await createFlowWorld();
    const complaint = await file(world);
    expect(Date.parse(complaint.deadlineSim)).toBe(Date.parse("2026-10-22T23:59:59-03:00"));
    const timers = await milestones(world, complaint);
    expect(timers.map((timer) => [timer.payload.milestone, Date.parse(timer.dueAtSim), timer.status])).toEqual([
      ["OPERATOR_REMINDER", Date.parse("2026-10-15T10:00:00-03:00"), "SCHEDULED"],
      ["SUPERVISOR_ESCALATION", Date.parse("2026-10-20T10:00:00-03:00"), "SCHEDULED"],
      ["DEADLINE", Date.parse("2026-10-22T23:59:59-03:00"), "SCHEDULED"],
    ]);
    expect(timers.every((timer) => timer.scheduleName === undefined)).toBe(true);
  });
});

describe("[FL-077] [FL-078] [FL-079] the milestones fire", () => {
  it("[FL-077] [FL-078] [FL-079] the reminder notes the case with no turn and no message; the escalation puts it AT_RISK with a supervisor alert; the deadline OVERDUE with its metric", async () => {
    const world = await createFlowWorld();
    const complaint = await file(world);
    world.harness.script(() => {
      throw new Error("a milestone never runs a turn");
    });
    const before = (await world.connector.conversations.listMessages("demo", "cus-0027")).length;

    await world.advance({ kind: "advanceTo", to: "2026-10-15T10:00:00-03:00" });
    const [reminder] = await milestones(world, complaint);
    expect(reminder).toMatchObject({ status: "FIRED" });
    expect((await world.connector.audit.listByAction("demo", "SLA_REMINDER")).some((entry) => JSON.stringify(entry.refs).includes(complaint.complaintId))).toBe(true);
    expect((await world.connector.caseItems.listNotes("demo", complaint.complaintId)).length).toBeGreaterThan(0);
    expect((await world.connector.conversations.listMessages("demo", "cus-0027")).length).toBe(before);

    await world.advance({ kind: "advanceTo", to: "2026-10-20T10:00:00-03:00" });
    expect(await current(world, complaint)).toMatchObject({ slaState: "AT_RISK" });
    expect((await world.connector.audit.listByAction("demo", "SUPERVISOR_ALERT")).some((entry) => JSON.stringify(entry.refs).includes(complaint.complaintId))).toBe(true);

    await world.advance({ kind: "advanceTo", to: "2026-10-23T00:00:00-03:00" });
    expect(await current(world, complaint)).toMatchObject({ slaState: "OVERDUE" });
    expect((await milestones(world, complaint)).map((timer) => timer.status)).toEqual(["FIRED", "FIRED", "FIRED"]);
    expect(world.logs.some((line) => line.includes("SlaOverdue"))).toBe(true);
    expect(world.harness.turns.filter((turn) => turn.event.type !== "CUSTOMER_MESSAGE")).toEqual([]);
  });
});

describe("[FL-080] the written answer cancels the milestones", () => {
  it("[FL-080] ANSWERED cancels the three milestones with a new version, and adds the automatic closure", async () => {
    const world = await createFlowWorld();
    const complaint = await file(world);
    const versions = (await milestones(world, complaint)).map((timer) => timer.version);
    await world.tap("cus-0027", "ACCEPT_EMAIL");
    world.harness.script(answering());
    await world.phone("cus-0027", { type: "text", text: REVIEW });
    await answerChallenge(world, "cus-0027");
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED" });
    const timers = await milestones(world, complaint);
    expect(timers.map((timer) => timer.status)).toEqual(["CANCELLED", "CANCELLED", "CANCELLED"]);
    expect(timers.map((timer) => timer.version)).toEqual(versions.map((version) => version + 1));
    expect((await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).filter((timer) => timer.kind === "AUTO_CLOSE" && timer.status === "SCHEDULED")).toHaveLength(1);
  });
});

describe("[FL-083] automatic closure after the answer", () => {
  it("[FL-083] five business days after ANSWERED the complaint is CLOSED with its STATUS entry", async () => {
    const world = await createFlowWorld();
    const complaint = await file(world);
    await world.tap("cus-0027", "ACCEPT_EMAIL");
    world.harness.script(answering());
    await world.phone("cus-0027", { type: "text", text: REVIEW });
    await answerChallenge(world, "cus-0027");
    const close = (await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).find((timer) => timer.kind === "AUTO_CLOSE");
    expect(Date.parse(close?.dueAtSim ?? "")).toBeGreaterThan(Date.parse("2026-10-14T00:00:00-03:00"));
    await world.advance({ kind: "advanceTo", to: close?.dueAtSim ?? "" });
    expect(await current(world, complaint)).toMatchObject({ status: "CLOSED" });
    const register = await world.connector.chains.listRegisterByComplaint("demo", 1, complaint.complaintNumber);
    expect(register.sort((a, b) => a.seq - b.seq).at(-1)).toMatchObject({ eventType: "STATUS", status: "CLOSED" });
  });

  it("[FL-083] a message of the customer about the complaint in the meantime reschedules the closure", async () => {
    const world = await createFlowWorld();
    const complaint = await file(world);
    await world.tap("cus-0027", "ACCEPT_EMAIL");
    world.harness.script(answering());
    await world.phone("cus-0027", { type: "text", text: REVIEW });
    await answerChallenge(world, "cus-0027");
    const first = (await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).find((timer) => timer.kind === "AUTO_CLOSE");
    await world.advance({ kind: "advanceTo", to: "2026-10-13T10:00:00-03:00" });
    world.harness.script(() => [reply("Tu reclamo ya tiene respuesta escrita; si querés lo revisamos.")]);
    await world.phone("cus-0027", { type: "text", text: "¿Y mi transferencia?" });
    const moved = (await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).find((timer) => timer.kind === "AUTO_CLOSE");
    expect(Date.parse(moved?.dueAtSim ?? "")).toBeGreaterThan(Date.parse(first?.dueAtSim ?? ""));
    await world.advance({ kind: "advanceTo", to: first?.dueAtSim ?? "" });
    expect((await current(world, complaint))?.status).toBe("ANSWERED");
  });
});
