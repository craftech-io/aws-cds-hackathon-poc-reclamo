// FL-024, FL-034, FL-035, FL-036, FL-087 · /app/approvals on the console alone (BFF and Cognito
// scripted, no AWS): the agent's requests above its cap, approving with the recent-login prompt in
// place (a sign-in of 20 minutes ago → the bilingual password prompt → password → the approval goes
// on; cancel → the 403 stays and nothing else happens), rejecting with a reason, and an approval above
// the operator's cap that only a supervisor decides.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import type { RouterOutputs } from "../src/lib/trpc-router.ts";
import { approvalsCopy } from "../src/views/approvals/copy.ts";
import { loginCopy } from "../src/views/login/copy.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, refusal, routeApi } from "./support/api-route";
import { PASSWORD_VERIFIER, routeCognito, tokensAnswer } from "./support/cognito-route";
import { type FakeClaims, plantSession } from "./support/session";

type ApprovalList = RouterOutputs["approvals"]["list"];
type ApprovalItem = ApprovalList["items"][number];

// Fixture password of a scripted pool: it only ever reaches page.route.
const PASSWORD = "Fixture-Password-1!";
const TWENTY_MINUTES = 20 * 60;
const OPERATOR: FakeClaims = { username: "operator-01", role: "OPERATOR", worldId: "demo", signedInAgo: 60 };
const STALE_OPERATOR: FakeClaims = { ...OPERATOR, signedInAgo: TWENTY_MINUTES };
const SUPERVISOR: FakeClaims = { username: "supervisor-01", role: "SUPERVISOR", worldId: "demo", signedInAgo: 60 };

function approval(overrides: Partial<ApprovalItem>): ApprovalItem {
  return {
    approvalId: "apr-c13",
    complaintId: "cmp-c13",
    complaintNumber: "R-2026-000131",
    customerId: "cus-c13",
    action: "APPLY_PAYMENT",
    amount: { amount: 312400, text: "$ 312.400,00" },
    capTier: "OPERATOR",
    capExceeded: { tier: "AGENT", cap: { amount: 250000, text: "$ 250.000,00" } },
    evidenceId: "evd-c13-match",
    justification: "Pago conciliado con la línea de la rendición del lote del 07/10.",
    requestedBy: "AGENT",
    requestedAtSim: "2026-10-07T13:20:00.000Z",
    expiresAtSim: "2026-10-09T13:20:00.000Z",
    expiresText: "viernes 09/10",
    lapsed: false,
    decidableByMe: true,
    version: 1,
    ...overrides,
  };
}

const ABOVE_OPERATOR = approval({
  approvalId: "apr-c24",
  complaintId: "cmp-c24",
  complaintNumber: "R-2026-000142",
  customerId: "cus-c24",
  action: "REFUND_DUPLICATE",
  amount: { amount: 212000, text: "$ 212.000,00" },
  capTier: "SUPERVISOR",
  capExceeded: { tier: "OPERATOR", cap: { amount: 150000, text: "$ 150.000,00" } },
});

function list(items: readonly ApprovalItem[]): ApiAnswer {
  return { data: { simNow: "2026-10-07T13:30:00.000Z", items: [...items] } satisfies ApprovalList };
}

interface Scripted {
  readonly decideBodies: unknown[];
  calls: Awaited<ReturnType<typeof routeApi>>;
  /** When true, `approvals.decide` refuses with LOGIN_NOT_RECENT. */
  stale: boolean;
}

/** The BFF of these specs: the list, then (after a decision) the list without the decided ones. */
async function scriptBff(page: Page, items: readonly ApprovalItem[], options: { readonly stale?: boolean } = {}): Promise<Scripted> {
  let decided = new Set<string>();
  const scripted: Scripted = { decideBodies: [], calls: [], stale: options.stale ?? false };
  const calls = await routeApi(page, (path) => {
    if (path === "approvals.list") return list(items.filter((item) => !decided.has(item.approvalId)));
    if (path === "approvals.decide") {
      if (scripted.stale) return refusal("FORBIDDEN", 403, "LOGIN_NOT_RECENT");
      const body = scripted.decideBodies.at(-1) as { "0"?: { approvalId?: string; decision?: string } } | undefined;
      const input = body?.["0"];
      decided = new Set([...decided, input?.approvalId ?? ""]);
      return { data: input?.decision === "REJECTED" ? { decision: "REJECTED", replay: false, status: "HUMAN_REVIEW" } : { decision: "APPROVED", replay: false, eventId: "evt-apr-1" } };
    }
    if (path === "clock.get") return { data: { mode: "PAUSED", simNow: "2026-10-07T13:30:00.000Z" } };
    return NOT_IMPLEMENTED;
  });
  // Registered after routeApi, so it runs first: it keeps the body and hands the request on.
  await page.route("**/api/approvals.decide**", async (route) => {
    scripted.decideBodies.push(route.request().postDataJSON());
    await route.fallback();
  });
  scripted.calls = calls;
  return scripted;
}

function decideCalls(scripted: Scripted): number {
  return scripted.calls.filter((call) => call.path === "approvals.decide").length;
}

function row(page: Page, number: string) {
  return page.getByRole("table", { name: approvalsCopy.caption }).getByRole("row").filter({ hasText: number });
}

test.describe("approvals [FL-024] [FL-034] [FL-087]", () => {
  test("[FL-024] lists the agent's request with its amount, the cap it went over, the evidence and the expiry", async ({ page }) => {
    await scriptBff(page, [approval({})]);
    await plantSession(page, OPERATOR);
    await page.goto("/app/approvals");
    await expect(page.getByRole("heading", { name: copy.views.approvals.title })).toBeVisible();
    const first = row(page, "R-2026-000131");
    await expect(first).toContainText("$ 312.400,00");
    await expect(first).toContainText(approvalsCopy.capOf.AGENT("$ 250.000,00"));
    await expect(first).toContainText(approvalsCopy.action.APPLY_PAYMENT);
    await expect(first).toContainText("viernes 09/10");
    await expect(first.getByRole("link", { name: approvalsCopy.evidenceLink })).toHaveAttribute("href", "/app/complaints/cmp-c13#evidence");
    await expect(page.getByText(approvalsCopy.tierHint.OPERATOR)).toBeVisible();
  });

  test("[FL-087] with a recent sign-in, approving enqueues the decision once and the list reads again", async ({ page }) => {
    const scripted = await scriptBff(page, [approval({})]);
    await plantSession(page, OPERATOR);
    await page.goto("/app/approvals");
    await row(page, "R-2026-000131").getByRole("button", { name: approvalsCopy.approve }).click();
    await expect(page.getByText(approvalsCopy.approved)).toBeVisible();
    expect(decideCalls(scripted)).toBe(1);
    expect(scripted.decideBodies[0]).toMatchObject({ "0": { complaintId: "cmp-c13", approvalId: "apr-c13", decision: "APPROVED" } });
    await expect(page.getByText(approvalsCopy.empty)).toBeVisible();
  });

  test("[FL-087] a sign-in of 20 minutes ago: the bilingual password prompt opens, the password confirms and the approval goes on", async ({ page }) => {
    const scripted = await scriptBff(page, [approval({})], { stale: true });
    const cognito = await routeCognito(page, {
      InitiateAuth: PASSWORD_VERIFIER,
      RespondToAuthChallenge: () => {
        scripted.stale = false;
        return tokensAnswer({ ...OPERATOR, signedInAgo: 0 });
      },
    });
    await plantSession(page, STALE_OPERATOR);
    await page.goto("/app/approvals");
    await row(page, "R-2026-000131").getByRole("button", { name: approvalsCopy.approve }).click();

    const dialog = page.getByRole("dialog", { name: loginCopy.stepUp.title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Approving money requires a recent sign-in");
    await dialog.getByLabel(loginCopy.credentials.password, { exact: true }).fill(PASSWORD);
    await dialog.getByRole("button", { name: loginCopy.credentials.submit }).click();

    await expect(dialog.getByText(loginCopy.stepUp.done)).toBeVisible();
    await expect(page.getByText(approvalsCopy.approved)).toBeVisible();
    expect(decideCalls(scripted)).toBe(2);
    expect(cognito.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of cognito) expect(call.body).not.toContain(PASSWORD);
  });

  test("[FL-087] cancelling the password prompt leaves the 403 on screen and decides nothing", async ({ page }) => {
    const scripted = await scriptBff(page, [approval({})], { stale: true });
    const cognito = await routeCognito(page, {});
    await plantSession(page, STALE_OPERATOR);
    await page.goto("/app/approvals");
    await row(page, "R-2026-000131").getByRole("button", { name: approvalsCopy.approve }).click();

    const dialog = page.getByRole("dialog", { name: loginCopy.stepUp.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: loginCopy.close }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("alert").filter({ hasText: "15 minutos" })).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(decideCalls(scripted)).toBe(1);
    expect(cognito).toEqual([]);
    await expect(page.getByText(approvalsCopy.approved)).toHaveCount(0);
    await expect(row(page, "R-2026-000131")).toBeVisible();
  });
});

test.describe("rejection and tiers [FL-035] [FL-036] [FL-034]", () => {
  test("[FL-035] rejecting asks for the reason and sends it; the case goes to a person", async ({ page }) => {
    const scripted = await scriptBff(page, [approval({ action: "REVERSE_CHARGE", amount: { amount: 38900, text: "$ 38.900,00" } })]);
    await plantSession(page, OPERATOR);
    await page.goto("/app/approvals");
    const target = row(page, "R-2026-000131");
    await target.getByRole("button", { name: approvalsCopy.reject }).click();
    const confirm = target.getByRole("button", { name: approvalsCopy.confirmReject });
    await expect(confirm).toBeDisabled();
    await target.getByLabel(approvalsCopy.rejectReason).fill("El cargo corresponde a un pedido del 02/09");
    await confirm.click();
    await expect(page.getByText(approvalsCopy.rejected)).toBeVisible();
    expect(scripted.decideBodies[0]).toMatchObject({ "0": { decision: "REJECTED", reason: "El cargo corresponde a un pedido del 02/09" } });
  });

  test("[FL-036] an operator cannot decide above the operator's cap; the BFF's refusal is explained", async ({ page }) => {
    await scriptBff(page, [approval({}), { ...ABOVE_OPERATOR, decidableByMe: false }]);
    await plantSession(page, OPERATOR);
    await page.goto("/app/approvals");
    const above = row(page, "R-2026-000142");
    await expect(above).toContainText(approvalsCopy.needsTier.SUPERVISOR);
    await expect(above).toContainText(approvalsCopy.capOf.OPERATOR("$ 150.000,00"));
    await expect(above.getByRole("button", { name: approvalsCopy.approve })).toHaveCount(0);
    await expect(row(page, "R-2026-000131").getByRole("button", { name: approvalsCopy.approve })).toBeVisible();
  });

  test("[FL-036] [FL-034] a supervisor approves above the operator's cap", async ({ page }) => {
    const scripted = await scriptBff(page, [ABOVE_OPERATOR]);
    await plantSession(page, SUPERVISOR);
    await page.goto("/app/approvals");
    await expect(page.getByText(approvalsCopy.tierHint.SUPERVISOR)).toBeVisible();
    await row(page, "R-2026-000142").getByRole("button", { name: approvalsCopy.approve }).click();
    await expect(page.getByText(approvalsCopy.approved)).toBeVisible();
    expect(scripted.decideBodies[0]).toMatchObject({ "0": { approvalId: "apr-c24", decision: "APPROVED" } });
  });

  test("[FL-036] a refusal for the cap tier names the reason", async ({ page }) => {
    await routeApi(page, (path) => {
      if (path === "approvals.list") return list([approval({})]);
      if (path === "approvals.decide") return refusal("FORBIDDEN", 403, "CAP_TIER");
      return NOT_IMPLEMENTED;
    });
    await plantSession(page, OPERATOR);
    await page.goto("/app/approvals");
    await row(page, "R-2026-000131").getByRole("button", { name: approvalsCopy.approve }).click();
    await expect(page.getByText(approvalsCopy.byReason["CAP_TIER"] ?? "")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
