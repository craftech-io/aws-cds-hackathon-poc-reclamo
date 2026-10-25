import { describe, expect, it } from "vitest";
import { ALL, NO_FILTERS, applyFilters, countsFor, reminderFired, typesOf, type InboxItem } from "./inbox-model";

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    complaintId: "cmp-1",
    complaintNumber: "R-2026-000123",
    kind: "RECLAMO",
    type: "PAYMENT_NOT_REFLECTED",
    status: "INVESTIGATING",
    priority: "NORMAL",
    control: "AGENT",
    origin: "LIVE",
    customerId: "cus-c01",
    summary: "Pago no reflejado",
    filedAtSim: "2026-10-07T13:10:00.000Z",
    deadlineSim: "2026-10-23T02:59:59.000Z",
    deadlineText: "jueves 22/10",
    businessDaysLeft: 10,
    slaState: "ON_TIME",
    nextMilestone: { milestone: "OPERATOR_REMINDER", dueAtSim: "2026-10-15T13:00:00.000Z", dueText: "jueves 15/10" },
    blockedBy: "AGENT",
    openTasks: 0,
    handoffReason: null,
    pinned: false,
    ...overrides,
  } as InboxItem;
}

const ITEMS = [
  item({ complaintId: "cmp-1", pinned: true, blockedBy: "NETWORK", status: "AWAITING_SETTLEMENT" }),
  item({ complaintId: "cmp-2", blockedBy: "CUSTOMER", status: "AWAITING_CUSTOMER", slaState: "AT_RISK", type: "DUPLICATE_DEBIT" }),
  item({ complaintId: "cmp-3", blockedBy: "PERSON", status: "HUMAN_REVIEW", control: "OPERATOR", slaState: "OVERDUE", nextMilestone: null }),
];

describe("inbox filters [FL-097]", () => {
  it("[FL-097] keeps the BFF order (main story first) when nothing is filtered", () => {
    expect(applyFilters(ITEMS, NO_FILTERS).map((row) => row.complaintId)).toEqual(["cmp-1", "cmp-2", "cmp-3"]);
  });

  it("[FL-097] a network wait is the network's, never the customer's", () => {
    expect(applyFilters(ITEMS, { ...NO_FILTERS, blockedBy: "CUSTOMER" }).map((row) => row.complaintId)).toEqual(["cmp-2"]);
    expect(applyFilters(ITEMS, { ...NO_FILTERS, blockedBy: "NETWORK" }).map((row) => row.status)).toEqual(["AWAITING_SETTLEMENT"]);
  });

  it("[FL-097] counts each option with the other filters applied", () => {
    const counts = countsFor(ITEMS, { ...NO_FILTERS, sla: "AT_RISK" }, "blockedBy");
    expect(counts[ALL]).toBe(1);
    expect(counts["CUSTOMER"]).toBe(1);
    expect(counts["NETWORK"]).toBeUndefined();
    expect(countsFor(ITEMS, NO_FILTERS, "control")).toEqual({ ALL: 3, AGENT: 2, OPERATOR: 1 });
  });

  it("[FL-097] combines filters and offers only the types present", () => {
    expect(applyFilters(ITEMS, { ...NO_FILTERS, control: "OPERATOR", sla: "OVERDUE" })).toHaveLength(1);
    expect(applyFilters(ITEMS, { ...NO_FILTERS, control: "OPERATOR", sla: "ON_TIME" })).toHaveLength(0);
    expect(typesOf(ITEMS)).toEqual(["PAYMENT_NOT_REFLECTED", "DUPLICATE_DEBIT"]);
  });
});

describe("day-5 reminder mark [FL-077]", () => {
  it("[FL-077] marks an open complaint whose next milestone is past the reminder", () => {
    expect(reminderFired(item({ nextMilestone: { milestone: "SUPERVISOR_ESCALATION", dueAtSim: "2026-10-20T13:00:00.000Z", dueText: "martes 20/10" } }))).toBe(true);
    expect(reminderFired(item({ nextMilestone: null }))).toBe(true);
  });

  it("[FL-077] does not mark before the reminder, a closed complaint or a query", () => {
    expect(reminderFired(item({}))).toBe(false);
    expect(reminderFired(item({ status: "ANSWERED", nextMilestone: null }))).toBe(false);
    expect(reminderFired(item({ kind: "CONSULTA", nextMilestone: null }))).toBe(false);
  });
});
