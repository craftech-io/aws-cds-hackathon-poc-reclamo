// FL-097, FL-077 · /app/inbox on the console alone (BFF scripted, no AWS): complaints by deadline with
// the main story pinned, the business days left and the SLA state, the next milestone and the day-5
// reminder mark, who each complaint waits for (a network wait is never the customer's), filters that
// say how many rows they would show, closed ones on request, and the row that opens the case.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import type { RouterOutputs } from "../src/lib/trpc-router.ts";
import { inboxCopy } from "../src/views/inbox/copy.ts";
import { NOT_IMPLEMENTED, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

type InboxAnswer = RouterOutputs["inbox"]["list"];
type InboxItem = InboxAnswer["items"][number];

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    complaintId: "cmp-c01",
    complaintNumber: "R-2026-000123",
    kind: "RECLAMO",
    type: "PAYMENT_NOT_REFLECTED",
    status: "AWAITING_SETTLEMENT",
    priority: "NORMAL",
    control: "AGENT",
    origin: "LIVE",
    customerId: "cus-c01",
    summary: "Pagó la cuota 4 en la Red de cobro Norte y no se refleja.",
    filedAtSim: "2026-10-07T13:12:00.000Z",
    deadlineSim: "2026-10-23T02:59:59.000Z",
    deadlineText: "jueves 22/10",
    businessDaysLeft: 10,
    slaState: "ON_TIME",
    nextMilestone: { milestone: "OPERATOR_REMINDER", dueAtSim: "2026-10-15T13:00:00.000Z", dueText: "jueves 15/10" },
    blockedBy: "NETWORK",
    openTasks: 0,
    handoffReason: null,
    pinned: true,
    ...overrides,
  };
}

const OPEN: readonly InboxItem[] = [
  item({}),
  item({
    complaintId: "cmp-c05",
    complaintNumber: "R-2026-000118",
    type: "DUPLICATE_DEBIT",
    status: "AWAITING_CUSTOMER",
    customerId: "cus-c05",
    summary: "Débito duplicado de la cuota 2.",
    deadlineText: "lunes 19/10",
    businessDaysLeft: 2,
    slaState: "AT_RISK",
    nextMilestone: { milestone: "DEADLINE", dueAtSim: "2026-10-20T02:59:59.000Z", dueText: "lunes 19/10" },
    blockedBy: "CUSTOMER",
    pinned: false,
  }),
  item({
    complaintId: "cmp-c11",
    complaintNumber: "R-2026-000101",
    type: "UNRECOGNIZED_CHARGE",
    status: "HUMAN_REVIEW",
    control: "OPERATOR",
    customerId: "cus-c11",
    summary: "Cargo de seguro que no reconoce.",
    deadlineText: "viernes 09/10",
    businessDaysLeft: 0,
    slaState: "OVERDUE",
    nextMilestone: null,
    blockedBy: "PERSON",
    openTasks: 1,
    pinned: false,
    priority: "HIGH",
  }),
];

const CLOSED = item({ complaintId: "cmp-c02", complaintNumber: "R-2026-000099", status: "ANSWERED", blockedBy: "NONE", nextMilestone: null, pinned: false, customerId: "cus-c02" });

async function scriptInbox(page: Page, open: readonly InboxItem[] = OPEN) {
  const bodies: string[] = [];
  const calls = await routeApi(page, (path) => {
    if (path === "inbox.list") {
      const closed = bodies.at(-1)?.includes("includeClosed") === true;
      return { data: { simNow: "2026-10-07T13:30:00.000Z", total: open.length, items: closed ? [...open, CLOSED] : [...open] } satisfies InboxAnswer };
    }
    if (path === "clock.get") return { data: { mode: "PAUSED", simNow: "2026-10-07T13:30:00.000Z" } };
    return NOT_IMPLEMENTED;
  });
  // Queries travel in the URL: keep it so the script knows which input it answers.
  await page.route("**/api/**", async (route) => {
    bodies.push(decodeURIComponent(new URL(route.request().url()).search));
    await route.fallback();
  });
  return { calls, urls: bodies };
}

function table(page: Page) {
  return page.getByRole("table", { name: inboxCopy.caption });
}

function rows(page: Page) {
  return table(page).locator("tbody > tr");
}

test.describe("inbox [FL-097]", () => {
  test("[FL-097] the main story is pinned on top, with its deadline, business days left and who it waits for", async ({ page }) => {
    await scriptInbox(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    const main = rows(page).first();
    await expect(main).toContainText("R-2026-000123");
    await expect(main).toContainText(inboxCopy.mainStory);
    await expect(main).toContainText("En plazo · 10 días hábiles");
    await expect(main).toContainText("jueves 22/10");
    await expect(main).toContainText(inboxCopy.milestone.OPERATOR_REMINDER);
    // A wait for the collection network's settlement is the network's, never the customer's.
    await expect(main).toContainText(inboxCopy.blockedBy.NETWORK);
    await expect(main).not.toContainText(inboxCopy.blockedBy.CUSTOMER);

    const risk = rows(page).filter({ hasText: "R-2026-000118" });
    await expect(risk).toContainText("En riesgo · 2 días hábiles");
    await expect(risk).toContainText(inboxCopy.blockedBy.CUSTOMER);
    const overdue = rows(page).filter({ hasText: "R-2026-000101" });
    await expect(overdue).toContainText("Vencido");
    await expect(overdue).toContainText(inboxCopy.blockedBy.PERSON);
    await expect(overdue).toContainText(inboxCopy.openTasks(1));
    await expect(overdue).toContainText(inboxCopy.highPriority);
    await expect(overdue).toContainText(inboxCopy.control.OPERATOR);
  });

  test("[FL-097] filters by who blocks, deadline state, type and control, each option with its count", async ({ page }) => {
    await scriptInbox(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox");
    const blocked = page.getByRole("group", { name: inboxCopy.filters.blockedBy });
    await expect(blocked.getByRole("button", { name: `${inboxCopy.blockedBy.CUSTOMER} (1)` })).toBeVisible();
    await blocked.getByRole("button", { name: `${inboxCopy.blockedBy.NETWORK} (1)` }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("R-2026-000123");
    await blocked.getByRole("button", { name: new RegExp(`${inboxCopy.filters.all} \\(3\\)`) }).click();

    await page.getByRole("group", { name: inboxCopy.filters.sla }).getByRole("button", { name: "Vencido (1)" }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("R-2026-000101");
    await page.getByRole("group", { name: inboxCopy.filters.sla }).getByRole("button", { name: new RegExp(`${inboxCopy.filters.all} \\(3\\)`) }).click();

    await page.getByLabel(inboxCopy.filters.type).selectOption({ label: "Débito duplicado" });
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel(inboxCopy.filters.type).selectOption({ label: inboxCopy.filters.allTypes });
    await page.getByRole("group", { name: inboxCopy.filters.control }).getByRole("button", { name: inboxCopy.control.OPERATOR }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByText(inboxCopy.filters.total(1, 3))).toBeVisible();
  });

  test("[FL-097] closed complaints only on request; a row opens its case", async ({ page }) => {
    const { urls } = await scriptInbox(page);
    await plantSession(page, { username: "compliance-01", role: "COMPLIANCE", worldId: "demo" });
    await page.goto("/app/inbox");
    await expect(rows(page)).toHaveCount(3);
    await page.getByLabel(inboxCopy.filters.includeClosed).check();
    await expect(rows(page)).toHaveCount(4);
    expect(urls.filter((url) => url.includes("includeClosed"))).toHaveLength(1);
    expect(urls.at(-1)).toContain('"includeClosed":true');
    await rows(page).filter({ hasText: "R-2026-000118" }).click();
    await expect(page).toHaveURL(/\/app\/complaints\/cmp-c05$/);
  });

  test("[FL-097] the type column says the type once: a summary that only repeats it is not shown again", async ({ page }) => {
    const seeded = item({ complaintId: "cmp-s01", complaintNumber: "R-2026-000050", type: "DUPLICATE_DEBIT", summary: "Débito duplicado", pinned: false });
    await scriptInbox(page, [OPEN[0] as InboxItem, seeded]);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox");
    await expect(rows(page)).toHaveCount(2);
    const typeCell = (row: number) => rows(page).nth(row).locator("td").nth(1);
    await expect(typeCell(1).getByText("Débito duplicado", { exact: true })).toHaveCount(1);
    // A summary that says more stays under the type.
    await expect(typeCell(0)).toContainText("Pago no reflejado");
    await expect(typeCell(0)).toContainText("Pagó la cuota 4 en la Red de cobro Norte y no se refleja.");
  });

  test("[FL-097] a row opens with the keyboard too", async ({ page }) => {
    await scriptInbox(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox");
    await rows(page).first().focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/complaints\/cmp-c01$/);
  });
});

test.describe("day-5 reminder [FL-077]", () => {
  test("[FL-077] the inbox marks the complaints whose reminder to the operator already fired", async ({ page }) => {
    await scriptInbox(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox");
    await expect(rows(page).filter({ hasText: "R-2026-000118" })).toContainText(inboxCopy.reminderFired);
    await expect(rows(page).filter({ hasText: "R-2026-000101" })).toContainText(inboxCopy.reminderFired);
    await expect(rows(page).first()).not.toContainText(inboxCopy.reminderFired);
  });
});
