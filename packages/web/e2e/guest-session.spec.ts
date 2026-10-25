// FL-121 and FL-123 · the session of a self-signup guest in a real browser (docs/landing-spec.md §9.5,
// §9.7): the sign-in with the email (SRP, the pool's ConsoleClient), a token without any group that the
// console still reads as GUEST of its own world, the world's status deciding between the inbox and the
// preparing screen (never a Cognito error), and "Salir" revoking the refresh token and going back to
// the landing as a public visitor, from the console and from the preparing screen. Cognito and the BFF
// are page.route; the address is the SES mailbox simulator's.
import { type Page, expect, test } from "@playwright/test";
import { TOKENS_KEY } from "../src/lib/auth/tokens.ts";
import { type SelfSignupClaims, selfSignupAuthResult, selfSignupTokens, simulatorEmail, simulatorWorld } from "../src/lib/auth/testing/guest-e2e.ts";
import { AUTH_COPY } from "../src/views/login/auth-copy.ts";
import { LANDING_COPY } from "../src/views/landing/copy.ts";
import { copy } from "../src/copy/console.ts";
import { NOT_IMPLEMENTED, routeApi } from "./support/api-route";
import { PASSWORD_VERIFIER, routeCognito } from "./support/cognito-route";

const es = AUTH_COPY.es;
// Fixture password of a scripted pool: it only ever reaches page.route.
const PASSWORD = "UnaClaveLarga2026";
const GUEST: SelfSignupClaims = { email: simulatorEmail("su1"), worldId: simulatorWorld("su1"), worldStatus: "READY" };
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function plantGuest(page: Page, claims: SelfSignupClaims, refreshToken?: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(selfSignupTokens(claims, refreshToken)) },
  );
}

async function worldIs(page: Page, worldStatus: string): Promise<void> {
  await routeApi(page, (path) => (path === "guest.status" ? { data: { worldStatus, queuePosition: 0 } } : NOT_IMPLEMENTED));
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByLabel(es.login.username, { exact: true }).fill(email);
  await page.getByLabel(es.login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: es.login.submit, exact: true }).click();
}

async function expectPublicLanding(page: Page): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The landing's "Probar Reclamo en regla", as a visitor sees it (on a phone, the header's copy sits in the closed menu).
  await expect(page.locator('a[data-cta="try"]:visible').filter({ hasText: LANDING_COPY.es.cta.try }).first()).toBeVisible();
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), TOKENS_KEY)).toBeNull();
}

for (const viewport of VIEWPORTS) {
  test.describe(`a self-signup guest's session on a ${viewport.name} [FL-121] [FL-123]`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("[FL-121] signs in with the email and, its world READY, gets its own world's console as GUEST without any group", async ({ page }) => {
      await worldIs(page, "READY");
      const cognito = await routeCognito(page, { InitiateAuth: PASSWORD_VERIFIER, RespondToAuthChallenge: selfSignupAuthResult(GUEST) });
      await page.goto("/login");
      await expect(page.getByRole("link", { name: es.login.tryIt })).toBeVisible();
      await signIn(page, GUEST.email);
      await page.waitForURL("**/app/inbox");
      await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible();
      await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.GUEST}`)).toBeVisible();
      // Its own world by a friendly name: the technical id (`gs-…`, `qa-…`) never reaches a self-signup guest.
      await expect(page.getByText(copy.app.ownWorld)).toBeVisible();
      // (The guest's own address is shown as its username; the simulator's address happens to carry the id.)
      expect((await page.locator("body").innerText()).replaceAll(GUEST.email, "")).not.toContain(GUEST.worldId);
      await expect(page.getByText(`${copy.app.worldLabel}:`)).toHaveCount(0);
      expect(JSON.parse(cognito[0]?.body ?? "{}")).toMatchObject({ AuthParameters: { USERNAME: GUEST.email } });
      for (const call of cognito) expect(call.body).not.toContain(PASSWORD);
    });

    test("[FL-123] Salir revokes the refresh token, clears the session and opens the landing as a public visitor", async ({ page }) => {
      await worldIs(page, "READY");
      const cognito = await routeCognito(page, { RevokeToken: { body: {} } });
      await plantGuest(page, GUEST, "e2e-refresh-self-signup");
      await page.goto("/app/inbox");
      await page.getByRole("button", { name: copy.app.signOut }).click();
      await expectPublicLanding(page);
      await expect.poll(() => cognito.map((call) => call.operation)).toEqual(["RevokeToken"]);
    });
  });
}

test.describe("a self-signup guest whose world is not ready [FL-121] [FL-123]", () => {
  test("[FL-121] after the sign-in it gets the preparing screen, never a raw Cognito error", async ({ page }) => {
    await worldIs(page, "REGISTERED");
    await routeCognito(page, { InitiateAuth: PASSWORD_VERIFIER, RespondToAuthChallenge: selfSignupAuthResult({ ...GUEST, worldStatus: "REGISTERED" }) });
    await page.goto("/login");
    await signIn(page, GUEST.email);
    await expect(page.getByRole("heading", { name: es.provisioning.preparingTitle })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Reclamo en regla" })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(/Cognito|Exception|NotAuthorized/);
  });

  test("[FL-123] Salir from the preparing screen goes to the landing too", async ({ page }) => {
    await worldIs(page, "CREATING");
    const cognito = await routeCognito(page, { RevokeToken: { body: {} } });
    await plantGuest(page, { ...GUEST, worldStatus: "CREATING" }, "e2e-refresh-self-signup");
    await page.goto("/app/inbox");
    await expect(page.getByText(es.provisioning.creating)).toBeVisible();
    await page.getByRole("button", { name: es.provisioning.signOut }).click();
    await expectPublicLanding(page);
    await expect.poll(() => cognito.map((call) => call.operation)).toEqual(["RevokeToken"]);
  });

  test("[FL-121] without a session, /signup/provisioning sends to /login with the 'account confirmed' notice", async ({ page }) => {
    await page.goto("/signup/provisioning");
    await page.waitForURL("**/login?notice=confirmed");
    await expect(page.getByText(es.login.confirmed)).toBeVisible();
  });
});
