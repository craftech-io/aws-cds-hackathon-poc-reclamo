// FL-064 · FL-075 · the compliance tape on the UI server (tests/ui-server): the real `appRouter` over
// the in-process `demo` world, sessions signed with the run's ephemeral key. An operator's collection
// reminder by WhatsApp is blocked by the real gate and shows in red with its English gloss; the tape
// shows zero violations, its chain verified against its anchors and an export that re-verifies.
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { verifyExport } from "../../../scripts/register/verify.ts";
import { sessionTokens, staffClaims } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { registerCopy } from "../src/views/register/copy.ts";
import { tapeCopy } from "../src/views/tape/copy.ts";
import { TOKENS_KEY } from "./support/session";

const BANNER_ES = "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de WhatsApp (cobro de deudas)";
const BANNER_EN = "BLOCKED · CH-WA-NO-COLLECTION · WhatsApp Commerce Policy (debt collection)";

async function signIn(page: Page, worldId: string, role: StaffRole): Promise<void> {
  const tokens = sessionTokens(staffClaims(worldId, role));
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(tokens) },
  );
}

/** One tRPC call with a session of `role` in `worldId`, as the console makes it (no batching). */
async function api(request: APIRequestContext, worldId: string, role: StaffRole, path: string, input: unknown, kind: "query" | "mutation") {
  const headers = { authorization: `Bearer ${sessionTokens(staffClaims(worldId, role)).idToken}` };
  const response =
    kind === "mutation"
      ? await request.post(`/api/${path}`, { headers, data: input })
      : await request.get(`/api/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
  const body = (await response.json()) as { result?: { data: unknown }; error?: { data?: { code?: string; reason?: string | null } } };
  return { status: response.status(), data: body.result?.data, error: body.error?.data };
}

interface TapeAnswer {
  readonly entries: readonly { readonly tapeId: string; readonly messageId?: string; readonly sender: string }[];
}

test.describe("compliance tape", () => {
  test("an operator's collection reminder by WhatsApp is blocked and shows in red with its English gloss [FL-064]", async ({ page, request }) => {
    const queued = await api(request, "demo", "OPERATOR", "customers.compose", { customerId: "cus-0009", kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Martín, tenés la cuota 3 vencida. Regularizá hoy." }, "mutation");
    expect(queued.status).toBe(200);
    const messageId = (queued.data as { messageId: string }).messageId;
    expect((await request.post("/__e2e/settle")).ok()).toBe(true);

    const blocked = await api(request, "demo", "COMPLIANCE", "tape.list", { decision: "BLOCKED", sender: "OPERATOR", ruleId: "CH-WA-NO-COLLECTION", limit: 20 }, "query");
    const entry = (blocked.data as TapeAnswer).entries.find((candidate) => candidate.messageId === messageId);
    expect(entry, "the gate wrote a BLOCKED entry for the operator's message").toBeDefined();
    expect(entry?.sender).toBe("OPERATOR:stf-operator-01");
    const dispatched = await api(request, "demo", "COMPLIANCE", "tape.list", { decision: "DISPATCH", limit: 500 }, "query");
    expect((dispatched.data as TapeAnswer).entries.some((candidate) => candidate.messageId === messageId)).toBe(false);

    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/tape");
    await expect(page.getByRole("heading", { name: copy.views.tape.title })).toBeVisible();
    await page.getByRole("group", { name: tapeCopy.filters.decision }).getByRole("button", { name: new RegExp(`^${tapeCopy.decisions.BLOCKED}`) }).click();
    await page.getByLabel(tapeCopy.filters.rule).selectOption("CH-WA-NO-COLLECTION");

    const detail = page.locator(`[data-tape-id="${entry?.tapeId ?? ""}"]`);
    await expect(detail).toBeVisible();
    await expect(detail).toHaveClass(/bg-danger-soft/);
    await expect(detail.getByText(BANNER_ES)).toBeVisible();
    await expect(detail.getByText(BANNER_EN)).toBeVisible();
    await expect(detail.locator('[lang="en"]')).toHaveText(BANNER_EN);
    const row = detail.locator("xpath=preceding-sibling::tr[1]");
    await expect(row).toContainText("BLOQUEADO");
    await expect(row).toContainText("stf-operator-01");
    await expect(row).toContainText("Recordatorio de mora");

    await detail.getByText(tapeCopy.detail.open).click();
    await expect(detail.getByText(tapeCopy.detail.reviewed)).toBeVisible();
    await expect(detail.getByText("bloquea", { exact: true })).toBeVisible();
  });

  test("the tape shows zero violations and its chain verified, and its export re-verifies without the stage [FL-075]", async ({ page }) => {
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/tape");
    await expect(page.getByRole("heading", { name: copy.views.tape.title })).toBeVisible();
    await expect(page.getByRole("table", { name: tapeCopy.caption })).toBeVisible();

    const violations = page.getByText(tapeCopy.stats.violations, { exact: true }).locator("xpath=..");
    await expect(violations).toContainText(/\b0\b/);
    await expect(violations).toContainText(tapeCopy.stats.violationsHint);

    const chain = page.getByRole("region", { name: tapeCopy.chainTitle }).first();
    await expect(chain.locator('[data-chain-result="ok"]')).toContainText(registerCopy.status.ok);

    await page.getByLabel(tapeCopy.filters.sender).selectOption("AGENT");
    const senders = page.locator("tbody tr:not([data-tape-id]) td:nth-child(3)");
    await expect(senders.first()).toHaveText(tapeCopy.senders.AGENT);
    for (const text of await senders.allTextContents()) expect(text).toBe(tapeCopy.senders.AGENT);

    await page.getByRole("button", { name: registerCopy.export.button }).click();
    const exported = page.getByRole("region", { name: tapeCopy.exportTitle });
    const csvLink = exported.getByRole("link", { name: registerCopy.export.csv });
    await expect(csvLink).toBeVisible();
    await expect(exported.locator("[data-chain-result]")).toBeVisible();
    const href = await csvLink.getAttribute("href");
    expect(href).toMatch(/tape-e\d+\.csv$/);
    const csv = await (await page.request.get(href ?? "")).text();
    const report = verifyExport(csv);
    expect(report).toMatchObject({ chain: "TAPE", worldId: "demo", consistent: true });
    expect(report.recomputed).not.toBe("broken");
  });

  test("on a phone (390x844) every decision is a card and a block's red banner is whole, not cut by a table [FL-064]", async ({ page, request }) => {
    const queued = await api(request, "demo", "OPERATOR", "customers.compose", { customerId: "cus-0009", kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Martín, tenés la cuota 3 vencida. Regularizá hoy." }, "mutation");
    expect(queued.status).toBe(200);
    expect((await request.post("/__e2e/settle")).ok()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/tape");
    await expect(page.getByRole("heading", { name: copy.views.tape.title })).toBeVisible();
    await expect(page.getByRole("table", { name: tapeCopy.caption })).toBeHidden();
    const card = page.locator('[data-tape-card]:has([data-tape-banner="BLOCKED"])').first();
    await card.scrollIntoViewIfNeeded();
    const banner = card.locator('[data-tape-banner="BLOCKED"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("CH-WA-NO-COLLECTION");
    const box = await banner.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
