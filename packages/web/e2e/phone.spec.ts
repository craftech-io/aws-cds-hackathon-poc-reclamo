// FL-129, FL-130 and FL-131 · the SMS code after the password, in a real browser (docs/architecture-guests.md
// §17): the enrolment of a self-signup's mobile (prefilled with the number of its form, editable, the code,
// the wrong code and its attempts left, the resend countdown) and then the console by itself; a sign-in of
// an enrolled account (only the last digits, the code sent by itself, the number cannot be typed); the
// refusals with Craftech's contact; and "Salir" ending the session's pass. The BFF is page.route: nothing
// sends an SMS. Phone and desktop widths, without horizontal scroll and without the contest's words.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralTerms } from "../../../scripts/lint/neutral-surfaces.ts";
import { TOKENS_KEY } from "../src/lib/auth/tokens.ts";
import { selfSignupTokens } from "../src/lib/auth/testing/guest-e2e.ts";
import { copy } from "../src/copy/console.ts";
import { AUTH_COPY } from "../src/views/login/auth-copy.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

const es = AUTH_COPY.es;
const en = AUTH_COPY.en;
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const inAMinute = () => new Date(Date.now() + 60_000).toISOString();

async function plantSelfSignup(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(selfSignupTokens({ email: "ana@empresa-ficticia.ar", worldId: "gs-abcdefgh23", worldStatus: "PHONE_PENDING" })) },
  );
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of VIEWPORTS) {
  test.describe(`the SMS code on a ${viewport.name} [FL-129] [FL-130]`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("[FL-129] a new self-signup enrols the number of its form, gets a wrong code right on the second try, and the console opens by itself", async ({ page }) => {
      let verified = false;
      let attempts = 0;
      const calls = await routeApi(page, (path): ApiAnswer => {
        if (path === "phone.status") return { data: verified ? { state: "PASSED" } : { state: "ENROL", phone: "+5491155550100", codeSent: false } };
        if (path === "phone.sendCode") return { data: { status: "CODE_SENT", purpose: "ENROL", lastDigits: "0100", resendAvailableAtReal: inAMinute() } };
        if (path === "phone.verify") {
          attempts += 1;
          if (attempts === 1) return { data: { status: "CODE_MISMATCH", attemptsLeft: 4 } };
          verified = true;
          return { data: { status: "VERIFIED" } };
        }
        if (path === "guest.status") return { data: { worldStatus: "READY", queuePosition: 0 } };
        return NOT_IMPLEMENTED;
      });
      await plantSelfSignup(page);
      await page.goto("/app/inbox");
      await expect(page.getByRole("heading", { name: es.phone.enrolTitle })).toBeVisible();
      const number = page.getByLabel(es.phone.number, { exact: true });
      await expect(number).toHaveValue("+5491155550100");
      await expect(number).toBeEditable();
      await expectNoHorizontalScroll(page);
      expect(findNeutralTerms("phone", await page.locator("body").innerText())).toEqual([]);
      await page.getByRole("button", { name: es.phone.send }).click();
      await expect(page.getByText(es.phone.sent)).toBeVisible();
      await expect(page.getByRole("button", { name: /Reenviar código \(\d+ s\)/ })).toBeDisabled();
      await page.getByLabel(es.phone.code, { exact: true }).fill("111111");
      await page.getByRole("button", { name: es.phone.verify }).click();
      await expect(page.getByText(es.phone.errors.mismatch(4))).toBeVisible();
      await page.getByLabel(es.phone.code, { exact: true }).fill("482 913");
      await page.getByRole("button", { name: es.phone.verify }).click();
      await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible();
      expect(calls.find((call) => call.path === "phone.sendCode")?.input).toEqual({ phone: "+5491155550100", locale: "es" });
      expect(calls.filter((call) => call.path === "phone.verify").map((call) => call.input)).toEqual([{ code: "111111" }, { code: "482913" }]);
      // Nothing of the console was asked before the session passed the code.
      const passedAt = calls.findLastIndex((call) => call.path === "phone.verify");
      expect(calls.slice(0, passedAt).filter((call) => !call.path.startsWith("phone.")).map((call) => call.path)).toEqual([]);
    });
  });
}

test.describe("every sign-in asks for its code [FL-130] [FL-131]", () => {
  test("[FL-130] an enrolled staff account: the code goes by itself to the verified number, shown only by its last digits, which cannot be changed", async ({ page }) => {
    let verified = false;
    const calls = await routeApi(page, (path): ApiAnswer => {
      if (path === "phone.status") return { data: verified ? { state: "PASSED" } : { state: "SIGN_IN", lastDigits: "0100", codeSent: false } };
      if (path === "phone.sendCode") return { data: { status: "CODE_SENT", purpose: "SIGN_IN", lastDigits: "0100", resendAvailableAtReal: inAMinute() } };
      if (path === "phone.verify") {
        verified = true;
        return { data: { status: "VERIFIED" } };
      }
      return NOT_IMPLEMENTED;
    });
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox?lang=en");
    await expect(page.getByRole("heading", { name: en.phone.signInTitle })).toBeVisible();
    await expect(page.getByText(`${en.phone.signInLead.before}0100${en.phone.signInLead.after}`)).toBeVisible();
    await expect(page.getByLabel(en.phone.number, { exact: true })).toHaveCount(0);
    await expect(page.getByText("+5491155550100")).toHaveCount(0);
    await expect(page.getByText(en.phone.sent)).toBeVisible();
    expect(calls.filter((call) => call.path === "phone.sendCode").map((call) => call.input)).toEqual([{ locale: "en" }]);
    await page.getByLabel(en.phone.code, { exact: true }).fill("123456");
    await page.getByRole("button", { name: en.phone.verify }).click();
    await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible();
  });

  test("[FL-131] the day's cap and an undeliverable number say so with Craftech's contact; five wrong codes ask for a new one", async ({ page }) => {
    const sends: ApiAnswer[] = [{ data: { status: "SMS_FAILED" } }, { data: { status: "CODE_SENT", purpose: "ENROL", lastDigits: "0123", resendAvailableAtReal: new Date(Date.now() - 1_000).toISOString() } }, { data: { status: "RATE_LIMITED", limit: "ACCOUNT" } }];
    await routeApi(page, (path): ApiAnswer => {
      if (path === "phone.status") return { data: { state: "ENROL", codeSent: false } };
      if (path === "phone.sendCode") return sends.shift() ?? NOT_IMPLEMENTED;
      if (path === "phone.verify") return { data: { status: "CODE_MISMATCH", attemptsLeft: 0 } };
      return NOT_IMPLEMENTED;
    });
    await plantSession(page, { username: "guest-03", role: "GUEST", worldId: "g03" });
    await page.goto("/app/inbox");
    await page.getByLabel(es.phone.number, { exact: true }).fill("+1 202 555 0123");
    await page.getByRole("button", { name: es.phone.send }).click();
    await expect(page.getByText(es.phone.errors.smsFailed)).toBeVisible();
    await expect(page.getByRole("link", { name: es.phone.contact })).toHaveAttribute("href", /utm_content=phone-verification/);
    await page.getByRole("button", { name: es.phone.send }).click();
    await page.getByLabel(es.phone.code, { exact: true }).fill("000000");
    await page.getByRole("button", { name: es.phone.verify }).click();
    await expect(page.getByText(es.phone.errors.burnt)).toBeVisible();
    await page.getByRole("button", { name: es.phone.send }).click();
    await expect(page.getByText(es.phone.errors.accountLimit)).toBeVisible();
  });

  test("[FL-130] Salir ends the session's pass before the tokens go", async ({ page }) => {
    const calls = await routeApi(page, (path): ApiAnswer => {
      if (path === "phone.status") return { data: { state: "SIGN_IN", lastDigits: "0100", codeSent: true, resendAvailableAtReal: inAMinute() } };
      if (path === "phone.endSession") return { data: { status: "ENDED" } };
      return NOT_IMPLEMENTED;
    });
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" });
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { name: es.phone.signInTitle })).toBeVisible();
    expect(calls.filter((call) => call.path === "phone.sendCode")).toEqual([]);
    await page.getByRole("button", { name: es.phone.signOut }).click();
    await expect.poll(() => calls.filter((call) => call.path === "phone.endSession").length).toBe(1);
    await expect(page).toHaveURL(/\/$/);
  });
});
