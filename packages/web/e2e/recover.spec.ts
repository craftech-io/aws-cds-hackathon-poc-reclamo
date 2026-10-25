// FL-122 · password recovery of a self-signup guest in a real browser (docs/landing-spec.md §9.6, §10
// case 8): the login's link is a full page load (the edge challenges `/login/recover`), the answer
// never says whether an email has an account, the code, the new password twice with the pool's
// policy, the wrong and expired code, the caps, and the way back to `/login` with the email pre-filled.
// The public procedures are page.route; the addresses are the SES mailbox simulator's.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralTerms } from "../../../scripts/lint/neutral-surfaces.ts";
import { type PublicAnswer, type PublicCall, EDGE_RATE_LIMITED, WAF_CHALLENGE, routePublicApi, simulatorEmail } from "../src/lib/auth/testing/guest-e2e.ts";
import { AUTH_COPY } from "../src/views/login/auth-copy.ts";

const es = AUTH_COPY.es;
const en = AUTH_COPY.en;
const NEW_PASSWORD = "OtraClaveLarga2027";
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function recoverApi(page: Page, forgot: () => PublicAnswer, reset: () => PublicAnswer = () => ({ data: { status: "PASSWORD_CHANGED" } })): Promise<PublicCall[]> {
  return routePublicApi(page, (call) => {
    if (call.procedure === "password.forgot") return forgot();
    if (call.procedure === "password.reset") return reset();
    return { http: 500, body: "unscripted" };
  });
}

async function requestCode(page: Page, email: string, copy = es): Promise<void> {
  await page.getByLabel(copy.recover.email, { exact: true }).fill(email);
  await page.getByRole("button", { name: copy.recover.submit }).click();
}

async function fillReset(page: Page, code: string, password = NEW_PASSWORD, copy = es): Promise<void> {
  await page.getByLabel(copy.recover.code, { exact: true }).fill(code);
  await page.getByLabel(copy.recover.newPassword, { exact: true }).fill(password);
  await page.getByLabel(copy.recover.confirmPassword, { exact: true }).fill(password);
  await page.getByRole("button", { name: copy.recover.save }).click();
}

for (const viewport of VIEWPORTS) {
  test.describe(`recovery on a ${viewport.name} [FL-122]`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("[FL-122] login link by a full page load → neutral answer → code and new password → /login with the email and the notice", async ({ page }) => {
      const email = simulatorEmail("su1");
      const answers: PublicAnswer[] = [{ data: { status: "CODE_MISMATCH" } }, { data: { status: "CODE_EXPIRED" } }, { data: { status: "PASSWORD_CHANGED" } }];
      const calls = await recoverApi(page, () => ({ data: { status: "CODE_SENT_IF_EXISTS" } }), () => answers.shift() ?? { http: 500 });
      await page.goto("/login");
      const documentRequest = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/login/recover");
      await page.getByRole("link", { name: es.login.forgot }).click();
      await documentRequest;
      await expect(page.getByRole("heading", { name: es.recover.title })).toBeVisible();
      expect(findNeutralTerms("/login/recover", await page.locator("body").innerText())).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await requestCode(page, email);
      await page.waitForURL("**/login/recover/reset");
      await expect(page.getByText(es.recover.neutral)).toBeVisible();
      await expect(page.getByLabel(es.recover.email, { exact: true })).toHaveCount(0);

      await fillReset(page, "111111");
      await expect(page.getByText(es.recover.mismatch)).toBeVisible();
      await fillReset(page, "222222");
      await expect(page.getByText(es.recover.expired)).toBeVisible();
      await expect(page.getByRole("link", { name: es.recover.requestAgain })).toHaveAttribute("href", "/login/recover");
      await fillReset(page, "333333");

      await page.waitForURL("**/login?notice=password-changed");
      await expect(page.getByText(es.login.passwordChanged)).toBeVisible();
      await expect(page.getByLabel(es.login.username, { exact: true })).toHaveValue(email);
      expect(calls.find((call) => call.procedure === "password.forgot")?.input).toEqual({ email, locale: "es" });
      expect(calls.filter((call) => call.procedure === "password.reset").map((call) => call.input)).toEqual(
        ["111111", "222222", "333333"].map((code) => ({ email, code, newPassword: NEW_PASSWORD, locale: "es" })),
      );
      for (const call of calls) expect(call.search).toBe("");
    });
  });
}

test.describe("what recovery never reveals [FL-122]", () => {
  test("[FL-122] an address with and one without an account get the very same screen", async ({ page }) => {
    const calls = await recoverApi(page, () => ({ data: { status: "CODE_SENT_IF_EXISTS" } }));
    const screens: string[] = [];
    for (const email of [simulatorEmail("su2"), simulatorEmail("su3")]) {
      await page.goto("/login/recover");
      await requestCode(page, email);
      await page.waitForURL("**/login/recover/reset");
      screens.push((await page.locator("main").innerText()).trim());
    }
    expect(screens[0]).toBe(screens[1]);
    expect(calls).toHaveLength(2);
  });

  test("[FL-122] a staff username is not an email: the form refuses it before anything is sent", async ({ page }) => {
    const calls = await recoverApi(page, () => ({ data: { status: "CODE_SENT_IF_EXISTS" } }));
    await page.goto("/login/recover");
    await requestCode(page, "supervisor-01");
    await expect(page.getByRole("alert")).toHaveText(es.signup.errors.email);
    expect(calls).toEqual([]);
  });

  test("[FL-122] the caps of the BFF and of the edge say so; a weak password never leaves the browser", async ({ page }) => {
    const answers: PublicAnswer[] = [{ data: { status: "RATE_LIMITED" } }, EDGE_RATE_LIMITED, { data: { status: "CODE_SENT_IF_EXISTS" } }];
    const calls = await recoverApi(page, () => answers.shift() ?? { http: 500 });
    await page.goto("/login/recover");
    const email = simulatorEmail("su4");
    await requestCode(page, email);
    await expect(page.getByText(es.common.rateLimited)).toBeVisible();
    await page.getByRole("button", { name: es.recover.submit }).click();
    await expect(page.getByText(es.common.rateLimited)).toBeVisible();
    await page.getByRole("button", { name: es.recover.submit }).click();
    await page.waitForURL("**/login/recover/reset");
    await fillReset(page, "123456", "corta");
    await expect(page.getByText(es.signup.errors.weakPassword)).toBeVisible();
    expect(calls.filter((call) => call.procedure === "password.reset")).toEqual([]);
  });

  test("[FL-122] in English, a firewall challenge reloads the page once and keeps the email", async ({ page }) => {
    const answers: PublicAnswer[] = [WAF_CHALLENGE, { data: { status: "CODE_SENT_IF_EXISTS" } }];
    const calls = await recoverApi(page, () => answers.shift() ?? { http: 500 });
    await page.goto("/login/recover?lang=en");
    await expect(page.getByRole("heading", { name: en.recover.title })).toBeVisible();
    const email = simulatorEmail("su5");
    const reload = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).searchParams.get("retry") === "1");
    await requestCode(page, email, en);
    await reload;
    await expect(page.getByLabel(en.recover.email, { exact: true })).toHaveValue(email);
    await page.getByRole("button", { name: en.recover.submit }).click();
    await page.waitForURL("**/login/recover/reset?lang=en");
    await expect(page.getByText(en.recover.neutral)).toBeVisible();
    expect(calls.map((call) => call.input)).toEqual([
      { email, locale: "en" },
      { email, locale: "en" },
    ]);
  });
});
