// FL-064, FL-065, FL-066 · /app/customers/:id on the console alone (BFF scripted, no AWS): the file
// of a customer with an overdue instalment, read from the core, and the composer where a person tries
// the "Recordatorio de mora" by WhatsApp. The console only enqueues it; the gate's decision lands on
// the tape, which the view reads: BLOCKED in red with its English gloss and the two permitted paths —
// the formal notice by email (REROUTED → ALLOWED → dispatch) and the human queue (a task, no send).
import { type Page, expect, test } from "@playwright/test";
import type { RouterOutputs } from "../src/lib/trpc-router.ts";
import { customerCopy } from "../src/views/customer/copy.ts";
import { NOT_IMPLEMENTED, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

type CustomerFile = RouterOutputs["customers"]["get"];
type TapeAnswer = RouterOutputs["tape"]["list"];
type TapeEntry = TapeAnswer["entries"][number];

const SIM_NOW = "2026-10-07T13:16:00.000Z";
const CUSTOMER_ID = "cus-c09";
const MESSAGE_ID = "opm-e2e-c09";

const FILE: CustomerFile = {
  customer: {
    customerId: CUSTOMER_ID,
    firstName: "Martín",
    lastName: "Olmedo",
    document: { type: "DNI", numberMasked: "••••8213" },
    phoneMasked: "+54 9 ••• •••-4410",
    emailMasked: "m•••@…",
    whatsapp: { optedIn: true, optedInAtSim: "2026-05-02T15:00:00.000Z", optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: false },
    account: { status: "ACTIVE" },
    wallet: { balance: 1250000, cvuMasked: "•••• 4410", outgoingFrozen: false, balanceMoney: { amount: 12500, text: "$ 12.500,00" } },
    loans: [
      {
        loanId: "lon-c09-1",
        label: "Préstamo personal 12 cuotas",
        status: "IN_ARREARS",
        outstanding: 41200000,
        outstandingMoney: { amount: 412000, text: "$ 412.000,00" },
        instalments: [
          { number: 1, dueDate: "2026-08-10", principal: 3000000, interest: 600000, vat: 126000, amount: 3726000, lateInterest: 0, outstanding: 0, status: "PAID", payments: [] },
          { number: 2, dueDate: "2026-09-10", principal: 3000000, interest: 600000, vat: 126000, amount: 3726000, lateInterest: 52000, outstanding: 3778000, status: "OVERDUE", payments: [] },
          { number: 3, dueDate: "2026-10-10", principal: 3000000, interest: 600000, vat: 126000, amount: 3726000, lateInterest: 0, outstanding: 3726000, status: "DUE", payments: [] },
        ],
      },
    ],
  },
  operations: [],
  operationsTruncated: false,
  complaints: [],
  conversation: { control: "AGENT", controlledBy: null, windowOpenUntilSim: null },
  challenge: { locked: false, failures: 0, attemptsLeft: 2 },
  composeKinds: ["OPERATOR_MESSAGE", "COMPLAINT_UPDATE", "COLLECTION_REMINDER"],
  simNow: SIM_NOW,
};

function entry(seq: number, overrides: Partial<TapeEntry>): TapeEntry {
  return {
    worldId: "demo",
    epoch: 1,
    seq,
    prevHash: "0".repeat(64),
    hash: String(seq).repeat(64).slice(0, 64),
    tapeId: `tp-${seq}`,
    atSim: SIM_NOW,
    decision: "ALLOWED",
    ruleIds: [],
    evaluated: [],
    ruleSetVersion: "ch-2026.10.06",
    sender: "OPERATOR:stf-operator-01",
    channel: "WHATSAPP",
    kind: "COLLECTION_REMINDER",
    messageId: MESSAGE_ID,
    customerRef: "c".repeat(64),
    ...overrides,
  } as TapeEntry;
}

const BLOCKED = entry(41, { tapeId: "tp-block", decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], evaluated: [{ ruleId: "CH-WA-NO-COLLECTION", result: "BLOCK" }] });
const OTHER = entry(40, { tapeId: "tp-other", sender: "AGENT", kind: "REPLY", messageId: "msg-agent-1", decision: "ALLOWED" });

type Stage = "QUEUED" | "BLOCKED" | "EMAIL" | "QUEUE";

function tapeOf(stage: Stage): TapeEntry[] {
  if (stage === "QUEUED") return [OTHER];
  if (stage === "BLOCKED") return [BLOCKED, OTHER];
  if (stage === "QUEUE") return [entry(42, { decision: "REROUTED", ruleIds: ["CH-WA-NO-COLLECTION"], rerouteOf: "tp-block", reroute: { route: "HUMAN_QUEUE" } }), BLOCKED, OTHER];
  const child = { channel: "EMAIL" as const, kind: "COLLECTION_NOTICE_EMAIL" as const, messageId: "rr-op-tp-block" };
  return [
    entry(45, { ...child, decision: "DISPATCH", result: "SENT" }),
    entry(44, { ...child, tapeId: "tp-child", decision: "ALLOWED", ruleIds: ["CH-FORMAL-CONTENT", "CH-CONTACT-HOURS"], rerouteOf: "tp-block" }),
    entry(43, { decision: "REROUTED", ruleIds: ["CH-WA-NO-COLLECTION"], rerouteOf: "tp-block", reroute: { route: "FORMAL_EMAIL", childTapeId: "tp-child" } }),
    BLOCKED,
    OTHER,
  ];
}

interface Script {
  stage: Stage;
  readonly bodies: Record<string, unknown[]>;
}

async function scriptCustomer(page: Page): Promise<Script> {
  const script: Script = { stage: "QUEUED", bodies: {} };
  let tapeReads = 0;
  await routeApi(page, (path) => {
    if (path === "customers.get") return { data: FILE };
    if (path === "customers.compose") return { data: { status: "QUEUED", messageId: MESSAGE_ID, eventId: `evt-${MESSAGE_ID}` } };
    if (path === "tape.list") {
      tapeReads += 1;
      // The worker takes a moment: the first read has no decision yet.
      if (script.stage === "QUEUED" && tapeReads > 1) script.stage = "BLOCKED";
      const entries = tapeOf(script.stage);
      return { data: { epoch: 1, total: entries.length, matching: entries.length, byDecision: {}, violations: 0, entries, cursor: null } satisfies TapeAnswer };
    }
    if (path === "conversation.reroute") {
      const route = (script.bodies["conversation.reroute"]?.at(-1) as { "0": { route: string } })["0"].route;
      script.stage = route === "HUMAN_QUEUE" ? "QUEUE" : "EMAIL";
      return route === "HUMAN_QUEUE"
        ? { data: { decision: "REROUTED", tapeId: "tp-42", reroutedTo: "HUMAN_QUEUE", ruleIds: ["CH-WA-NO-COLLECTION"] } }
        : { data: { decision: "QUEUED", tapeId: null, reroutedTo: "FORMAL_EMAIL", ruleIds: [], messageId: "rr-op-tp-block", eventId: "evt-rr-op-tp-block" } };
    }
    if (path === "clock.get") return { data: { mode: "PAUSED", simNow: SIM_NOW } };
    return NOT_IMPLEMENTED;
  });
  for (const path of ["customers.compose", "conversation.reroute"]) {
    await page.route(`**/api/${path}**`, async (route) => {
      (script.bodies[path] ??= []).push(route.request().postDataJSON());
      await route.fallback();
    });
  }
  return script;
}

const BANNER_ES = "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de WhatsApp (cobro de deudas)";
const BANNER_EN = "BLOCKED · CH-WA-NO-COLLECTION · WhatsApp Commerce Policy (debt collection)";
const TO_EMAIL = "Enviar aviso formal por email · Send a formal notice by email";
const TO_QUEUE = "Derivar a la cola humana · Route to the human queue";

async function tryCollectionReminder(page: Page): Promise<void> {
  await page.goto(`/app/customers/${CUSTOMER_ID}`);
  await expect(page.getByRole("heading", { name: "Martín Olmedo" })).toBeVisible();
  const composer = page.getByRole("region", { name: customerCopy.sections.composer });
  await composer.getByLabel(customerCopy.composer.kind).selectOption("COLLECTION_REMINDER");
  await composer.getByLabel(customerCopy.composer.channel).selectOption("WHATSAPP");
  await expect(composer.getByRole("textbox", { name: customerCopy.composer.text, exact: true })).toHaveValue(customerCopy.composer.drafts["COLLECTION_REMINDER"] ?? "");
  await composer.getByRole("button", { name: customerCopy.composer.send }).click();
}

test.describe("customer file and composer [FL-064]", () => {
  test("[FL-064] the file reads the core: wallet, the loan in arrears and its overdue instalment", async ({ page }) => {
    await scriptCustomer(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto(`/app/customers/${CUSTOMER_ID}`);
    await expect(page.getByRole("heading", { name: "Martín Olmedo" })).toBeVisible();
    await expect(page.getByText("$ 12.500,00")).toBeVisible();
    await expect(page.getByText(customerCopy.status.loan.IN_ARREARS)).toBeVisible();
    const instalments = page.getByRole("table", { name: customerCopy.loans.caption("Préstamo personal 12 cuotas") });
    await expect(instalments.getByRole("row").filter({ hasText: "Vencida" })).toContainText("$ 37.780,00");
    await expect(page.getByText(customerCopy.challenge.clear)).toBeVisible();
  });

  test("[FL-064] a 'Recordatorio de mora' by WhatsApp is blocked on the tape in red, with its English gloss and both permitted paths", async ({ page }) => {
    const script = await scriptCustomer(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await tryCollectionReminder(page);
    const trail = page.getByRole("region", { name: customerCopy.trail.title });
    const banner = trail.getByRole("alert").filter({ hasText: BANNER_ES });
    await expect(banner).toBeVisible();
    await expect(banner).toHaveClass(/bg-danger-soft/);
    await expect(banner).toContainText(BANNER_EN);
    await expect(banner.getByRole("button", { name: TO_EMAIL })).toBeVisible();
    await expect(banner.getByRole("button", { name: TO_QUEUE })).toBeVisible();
    expect(script.bodies["customers.compose"]?.[0]).toMatchObject({ "0": { customerId: CUSTOMER_ID, kind: "COLLECTION_REMINDER", channel: "WHATSAPP" } });
  });
});

test.describe("reroutes of the block [FL-065] [FL-066]", () => {
  test("[FL-065] the formal notice by email: REROUTED, then ALLOWED and its dispatch, decided from the tape", async ({ page }) => {
    const script = await scriptCustomer(page);
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await tryCollectionReminder(page);
    const trail = page.getByRole("region", { name: customerCopy.trail.title });
    await trail.getByRole("button", { name: TO_EMAIL }).click();
    await expect(trail.getByText("REENCAMINADO · REROUTED")).toBeVisible();
    await expect(trail.getByText("PERMITIDO · ALLOWED")).toBeVisible();
    await expect(trail.getByText(/ENVÍO · DISPATCH · enviado/)).toBeVisible();
    await expect(trail.getByRole("button", { name: TO_EMAIL })).toHaveCount(0);
    expect(script.bodies["conversation.reroute"]).toHaveLength(1);
    expect(script.bodies["conversation.reroute"]?.[0]).toMatchObject({ "0": { tapeId: "tp-block", route: "FORMAL_EMAIL", customerId: CUSTOMER_ID } });
  });

  test("[FL-066] the human queue: a task, nothing sent", async ({ page }) => {
    const script = await scriptCustomer(page);
    await plantSession(page, { username: "guest-03", role: "GUEST", worldId: "g03" });
    await tryCollectionReminder(page);
    const trail = page.getByRole("region", { name: customerCopy.trail.title });
    await trail.getByRole("button", { name: TO_QUEUE }).click();
    await expect(trail.getByText(customerCopy.trail.humanQueued)).toBeVisible();
    await expect(trail.getByText("REENCAMINADO · REROUTED")).toBeVisible();
    await expect(trail.getByText("PERMITIDO · ALLOWED")).toHaveCount(0);
    expect(script.bodies["conversation.reroute"]?.[0]).toMatchObject({ "0": { route: "HUMAN_QUEUE" } });
  });
});
