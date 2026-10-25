// FL-117, FL-120, FL-124 and FL-125 · a self-signup guest's world that is not ready, in a real browser
// (docs/landing-spec.md §9.4, §10 case 9): the fixed screen by the exact status of `guest.status` (in
// line with its position, building, "taking longer than expected" after 600 s), never a raw error and
// never an email promise; the console opening by itself at READY; an expired world asked for again
// with "Set up my environment" (`guest.requestWorld`); and the day's usage limit as a fixed notice.
// The session is planted (a self-signup token: the email as username, no group); the BFF is page.route.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralTerms } from "../../../scripts/lint/neutral-surfaces.ts";
import { TOKENS_KEY } from "../src/lib/auth/tokens.ts";
import { type SelfSignupClaims, selfSignupTokens, simulatorEmail, simulatorWorld } from "../src/lib/auth/testing/guest-e2e.ts";
import { AUTH_COPY } from "../src/views/login/auth-copy.ts";
import { copy } from "../src/copy/console.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

const es = AUTH_COPY.es;
const en = AUTH_COPY.en;
const GUEST: SelfSignupClaims = { email: simulatorEmail("su1"), worldId: simulatorWorld("su1"), worldStatus: "REGISTERED" };
const EMAIL_PROMISE = /te (vamos a )?avisar|avisamos por email|we'?ll (email|notify)|notify you/i;
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function plantGuest(page: Page, claims: SelfSignupClaims = GUEST): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(selfSignupTokens(claims)) },
  );
}

const status = (worldStatus: string, queuePosition = 0, extra: Record<string, unknown> = {}): ApiAnswer => ({ data: { worldStatus, queuePosition, ...extra } });

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of VIEWPORTS) {
  test.describe(`a world in preparation on a ${viewport.name} [FL-117] [FL-120]`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("[FL-117] [FL-120] in line with its position, then being built, then the inbox by itself", async ({ page }) => {
      let first: number | undefined;
      await routeApi(page, (path) => {
        if (path !== "guest.status") return NOT_IMPLEMENTED;
        first ??= Date.now();
        const elapsed = Date.now() - first;
        if (elapsed < 3_000) return status("REGISTERED", 3);
        return elapsed < 8_000 ? status("CREATING") : status("READY");
      });
      await plantGuest(page);
      await page.goto("/app/inbox");
      await expect(page.getByRole("heading", { name: es.provisioning.preparingTitle })).toBeVisible();
      const queued = page.getByRole("status").filter({ hasText: es.provisioning.queued.before.trim() });
      await expect(queued).toContainText(`${es.provisioning.queued.before}3${es.provisioning.queued.after}`);
      await expect(page.getByRole("heading", { name: es.provisioning.meanwhile })).toBeVisible();
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(EMAIL_PROMISE);
      expect(text).not.toMatch(/Cognito|NotAuthorized|Exception/);
      expect(findNeutralTerms("provisioning", text)).toEqual([]);
      await expectNoHorizontalScroll(page);
      await expect(page.getByText(es.provisioning.creating)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible({ timeout: 12_000 });
      expect(new URL(page.url()).pathname).toBe("/app/inbox");
    });
  });
}

test.describe("the wait, its end and the day's limit [FL-120] [FL-124] [FL-125]", () => {
  test("[FL-120] after 600 s it says it is taking longer than expected, still without promising an email", async ({ page }) => {
    await page.clock.install();
    await routeApi(page, (path) => (path === "guest.status" ? status("REGISTERED") : NOT_IMPLEMENTED));
    await plantGuest(page);
    await page.goto("/signup/provisioning");
    await expect(page.getByText(es.provisioning.preparingLead)).toBeVisible();
    await expect(page.getByText(es.provisioning.slow)).toHaveCount(0);
    await page.clock.fastForward("10:01");
    await expect(page.getByText(es.provisioning.slow)).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(EMAIL_PROMISE);
    expect(new URL(page.url()).pathname).toBe("/signup/provisioning");
  });

  test("[FL-124] an expired world: 'Set up my environment' asks for it again and the wait starts over", async ({ page }) => {
    let requested = false;
    const calls = await routeApi(page, (path) => {
      if (path === "guest.requestWorld") {
        requested = true;
        return { data: { status: "REGISTERED" } };
      }
      if (path === "guest.status") return requested ? status("REGISTERED") : status("EXPIRED");
      return NOT_IMPLEMENTED;
    });
    await plantGuest(page, { ...GUEST, worldStatus: "EXPIRED" });
    await page.goto("/app/inbox?lang=en");
    await expect(page.getByRole("heading", { name: en.provisioning.expiredTitle })).toBeVisible();
    await page.getByRole("button", { name: en.provisioning.expiredButton }).click();
    await expect(page.getByRole("heading", { name: en.provisioning.preparingTitle })).toBeVisible();
    await expect(page.getByText(en.provisioning.preparingLead)).toBeVisible();
    expect(calls.filter((call) => call.path === "guest.requestWorld")).toHaveLength(1);
  });

  test("[FL-124] asking too often says so and keeps the button", async ({ page }) => {
    await routeApi(page, (path) => {
      if (path === "guest.requestWorld") return { data: { status: "RATE_LIMITED" } };
      return path === "guest.status" ? status("EXPIRED") : NOT_IMPLEMENTED;
    });
    await plantGuest(page, { ...GUEST, worldStatus: "EXPIRED" });
    await page.goto("/signup/provisioning");
    await page.getByRole("button", { name: es.provisioning.expiredButton }).click();
    await expect(page.getByText(es.common.rateLimited)).toBeVisible();
    await expect(page.getByRole("button", { name: es.provisioning.expiredButton })).toBeEnabled();
  });

  test("[FL-125] the day's usage limit is a fixed notice inside the console, for a self-signup and an invited guest", async ({ page }) => {
    const limit = `${es.provisioning.usageLimit} · ${en.provisioning.usageLimit}`;
    await routeApi(page, (path) => (path === "guest.status" ? status("READY", 0, { usage: { turnsToday: 60, turnsPerDay: 60, limitReached: true } }) : NOT_IMPLEMENTED));
    await plantGuest(page, { ...GUEST, worldStatus: "READY" });
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible();
    await expect(page.getByText(limit)).toBeVisible();

    const invited = await page.context().newPage();
    await routeApi(invited, (path) => (path === "guest.status" ? status("READY", 0, { usage: { turnsToday: 150, turnsPerDay: 150, limitReached: true } }) : NOT_IMPLEMENTED));
    await plantSession(invited, { username: "guest-03", role: "GUEST", worldId: "g03" });
    await invited.goto("/app/inbox");
    await expect(invited.getByText(limit)).toBeVisible();
  });
});
