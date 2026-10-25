import { describe, expect, it } from "vitest";
import { type StaffRole, businessDaysBetween } from "@reclamo/shared";
import { claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { milestoneTimers, slaPlan } from "../complaints/sla";
import { TEST_HOLIDAYS, complaintsKit } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, complaint } from "../connector/testing";
import type { Complaint } from "../domain/complaint";
import { localDateAr } from "../services/business-days";
import { createEnqueuer } from "../worker/enqueue";
import { MAIN_STORY_NUMBER, type OperationsServices, bindOperations, blockedByOf, inboxRouter } from "./inbox";
import { createContextFactory, router } from "./trpc";

type NewComplaint = Parameters<typeof complaint>[1];

async function inboxWorld() {
  const kit = complaintsKit({ worldId: "demo" });
  await kit.seedWorld();
  await kit.connector.runtime.putClock({ worldId: "demo", mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  for (const date of TEST_HOLIDAYS) await kit.store.write({ kind: "put", table: "Reference", item: { pk: "REF#HOLIDAY#AR", sk: date, date } });
  let next = 0;
  const services: OperationsServices = {
    data: kit.connector,
    chains: () => kit.deps,
    enqueuer: (log) => createEnqueuer({ data: kit.connector, send: async () => undefined, queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/776805327629/${queue}`, now: () => TEST_NOW, log }),
    core: () => ({ call: async () => Promise.reject(new Error("the inbox never reads the core")) }),
    images: () => ({ get: async () => undefined }),
    presignMedia: async (key) => `https://media.invalid/${key}`,
    newId: (prefix) => `${prefix}-${String(++next).padStart(4, "0")}`,
  };
  const { issuer, directory, deps } = createTestDeps();
  directory.setWorld("demo", "READY", 1);
  const people: Record<string, { staffId: string; role: StaffRole }> = { operator: { staffId: "stf-operator-01", role: "OPERATOR" }, compliance: { staffId: "stf-compliance-01", role: "COMPLIANCE" } };
  for (const [name, person] of Object.entries(people)) directory.putStaff(staffRow("demo", person.staffId, person.role, `sub-${name}`));
  bindOperations(deps, services);
  const contextFor = createContextFactory(() => deps);
  const as = async (name: keyof typeof people) => {
    const person = people[name]!;
    const token = issuer.idToken({ sub: `sub-${name}`, ...claimsOf({ worldId: "demo", ...person }, name) });
    return router({ inbox: inboxRouter }).createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
  };
  /** A complaint filed at `filedAtSim` with its real deadline and its three milestone timers. */
  const file = async (overrides: NewComplaint & { complaintId: string; complaintNumber: string }, filedAtSim = SIM_NOW) => {
    const plan = slaPlan(filedAtSim, TEST_HOLIDAYS);
    const row = complaint("demo", { filedAtSim, deadlineSim: plan.deadlineSim, ...overrides });
    const timers = milestoneTimers({ worldId: "demo", epoch: 1, complaintId: overrides.complaintId, complaintNumber: overrides.complaintNumber, plan });
    await kit.connector.transact([kit.connector.complaints.createOp(row), ...timers.map((timer) => kit.connector.timers.putOp(timer))]);
    return row;
  };
  return { kit, as, file };
}

describe("inbox with deadlines [FL-097]", () => {
  it("[FL-097] lists open complaints by deadline, the main story pinned first, with the business days left of services/business-days.ts", async () => {
    const { as, file } = await inboxWorld();
    await file({ complaintId: "cmp-0001", complaintNumber: MAIN_STORY_NUMBER, status: "AWAITING_SETTLEMENT" });
    await file({ complaintId: "cmp-0002", complaintNumber: "R-2026-000101", customerId: "cus-0002", status: "INVESTIGATING" }, "2026-10-01T09:00:00-03:00");
    await file({ complaintId: "cmp-0003", complaintNumber: "R-2026-000105", customerId: "cus-0003", status: "AWAITING_CUSTOMER" }, "2026-10-05T12:00:00-03:00");
    const { items, simNow, total } = await (await as("operator")).inbox.list();
    expect(simNow).toBe(new Date(SIM_NOW).toISOString());
    expect(total).toBe(3);
    expect(items.map((item) => item.complaintNumber)).toEqual([MAIN_STORY_NUMBER, "R-2026-000101", "R-2026-000105"]);
    expect(items[0]).toMatchObject({ pinned: true, deadlineSim: "2026-10-22T23:59:59-03:00", deadlineText: "jueves 22/10", businessDaysLeft: 10 });
    for (const item of items) {
      expect(item.businessDaysLeft).toBe(businessDaysBetween(localDateAr(new Date(SIM_NOW)), localDateAr(new Date(item.deadlineSim)), TEST_HOLIDAYS));
    }
    // Monday 12/10 is a holiday: filed Thursday 01/10, the deadline is Friday 16/10 and six business days remain.
    expect(items[1]).toMatchObject({ deadlineSim: "2026-10-16T23:59:59-03:00", deadlineText: "viernes 16/10", businessDaysLeft: 6 });
  });

  it("[FL-097] says who blocks: a network or a settlement wait is never shown as the customer's", async () => {
    const { as, file } = await inboxWorld();
    const cases: Array<[string, Partial<Complaint>]> = [
      ["cmp-0011", { status: "AWAITING_SETTLEMENT" }],
      ["cmp-0012", { status: "AWAITING_NETWORK" }],
      ["cmp-0013", { status: "AWAITING_CUSTOMER" }],
      ["cmp-0014", { status: "HUMAN_REVIEW", handoff: { reason: "FRAUD", atSim: SIM_NOW } }],
      ["cmp-0015", { status: "INVESTIGATING", control: "OPERATOR" }],
      ["cmp-0016", { status: "INVESTIGATING" }],
    ];
    for (const [complaintId, overrides] of cases) await file({ complaintId, complaintNumber: `R-2026-0000${complaintId.slice(-2)}`, ...overrides });
    const { items } = await (await as("operator")).inbox.list();
    const by = Object.fromEntries(items.map((item) => [item.complaintId, item.blockedBy]));
    expect(by).toEqual({ "cmp-0011": "NETWORK", "cmp-0012": "NETWORK", "cmp-0013": "CUSTOMER", "cmp-0014": "PERSON", "cmp-0015": "PERSON", "cmp-0016": "AGENT" });
    expect(items.find((item) => item.complaintId === "cmp-0014")?.handoffReason).toBe("FRAUD");
    expect(blockedByOf({ status: "ANSWERED", control: "AGENT" })).toBe("NONE");
  });

  it("[FL-097] highlights AT_RISK and OVERDUE from the deadline, and never shows less than a milestone already raised", async () => {
    const { as, file } = await inboxWorld();
    await file({ complaintId: "cmp-0021", complaintNumber: "R-2026-000090", slaState: "ON_TIME" }, "2026-09-25T10:00:00-03:00");
    await file({ complaintId: "cmp-0022", complaintNumber: "R-2026-000080", slaState: "AT_RISK" }, "2026-09-10T10:00:00-03:00");
    await file({ complaintId: "cmp-0023", complaintNumber: "R-2026-000110", slaState: "AT_RISK" });
    const { items } = await (await as("operator")).inbox.list();
    const of = (complaintId: string) => items.find((item) => item.complaintId === complaintId)!;
    expect(of("cmp-0021")).toMatchObject({ slaState: "AT_RISK", businessDaysLeft: 2 });
    expect(of("cmp-0022").slaState).toBe("OVERDUE");
    expect(of("cmp-0022").businessDaysLeft).toBeLessThan(0);
    expect(of("cmp-0023").slaState).toBe("AT_RISK");
    expect(items[0]?.complaintId).toBe("cmp-0022");
  });

  it("[FL-097] shows the next milestone and the open human tasks of each complaint", async () => {
    const { as, file, kit } = await inboxWorld();
    await file({ complaintId: "cmp-0001", complaintNumber: MAIN_STORY_NUMBER, status: "HUMAN_REVIEW" });
    await kit.connector.caseItems.putNote({ worldId: "demo", complaintId: "cmp-0001", noteId: "note-1", kind: "HUMAN_TASK", atSim: SIM_NOW, author: "SYSTEM", text: "Cola humana", task: { status: "OPEN", route: "HUMAN_QUEUE" } });
    await kit.connector.caseItems.putNote({ worldId: "demo", complaintId: "cmp-0001", noteId: "note-2", kind: "HUMAN_TASK", atSim: SIM_NOW, author: "SYSTEM", text: "Hecha", task: { status: "DONE" } });
    const [item] = (await (await as("operator")).inbox.list()).items;
    expect(item).toMatchObject({ openTasks: 1, nextMilestone: { milestone: "OPERATOR_REMINDER", dueAtSim: "2026-10-15T10:00:00-03:00", dueText: "jueves 15/10" } });
  });

  it("[FL-097] filters by type, kind, status, control and blocker; closed complaints only when asked", async () => {
    const { as, file } = await inboxWorld();
    await file({ complaintId: "cmp-0031", complaintNumber: "R-2026-000031", type: "UNRECOGNIZED_CHARGE", status: "INVESTIGATING" });
    await file({ complaintId: "cmp-0032", complaintNumber: "R-2026-000032", type: "PAYMENT_NOT_REFLECTED", status: "AWAITING_SETTLEMENT" });
    await file({ complaintId: "cmp-0033", complaintNumber: "R-2026-000033", type: "INFORMATION_REQUEST", kind: "CONSULTA", status: "INVESTIGATING", control: "OPERATOR" });
    await file({ complaintId: "cmp-0034", complaintNumber: "R-2026-000034", status: "ANSWERED" });
    const operator = await as("operator");
    const ids = async (input?: Parameters<typeof operator.inbox.list>[0]) => (await operator.inbox.list(input)).items.map((item) => item.complaintId).sort();
    expect(await ids()).toEqual(["cmp-0031", "cmp-0032", "cmp-0033"]);
    expect(await ids({ type: ["UNRECOGNIZED_CHARGE"] })).toEqual(["cmp-0031"]);
    expect(await ids({ kind: "CONSULTA" })).toEqual(["cmp-0033"]);
    expect(await ids({ status: ["AWAITING_SETTLEMENT"] })).toEqual(["cmp-0032"]);
    expect(await ids({ control: "OPERATOR" })).toEqual(["cmp-0033"]);
    expect(await ids({ blockedBy: ["NETWORK"] })).toEqual(["cmp-0032"]);
    expect(await ids({ includeClosed: true })).toEqual(["cmp-0031", "cmp-0032", "cmp-0033", "cmp-0034"]);
    await expect(operator.inbox.list({ control: "NOBODY" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("[FL-097] reads only the principal's world, also for the read-only compliance role", async () => {
    const { as, file, kit } = await inboxWorld();
    await file({ complaintId: "cmp-0001", complaintNumber: MAIN_STORY_NUMBER });
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("g01", { complaintId: "cmp-0001" }))]);
    const { items } = await (await as("compliance")).inbox.list();
    expect(items.map((item) => item.complaintId)).toEqual(["cmp-0001"]);
  });
});
