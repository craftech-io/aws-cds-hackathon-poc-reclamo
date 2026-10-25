// FL-112 to FL-114 on the deployed stage · `/signup` as a visitor opens it (docs/landing-spec.md §9.2-§9.3,
// docs/architecture-guests.md §8), always in a browser that enforces the page's CSP. First, the documents
// `/signup` and `/login/recover` (the edge's rules 5 and 6 count, so no WAF interstitial stands in front of
// the form). Then the open form: its fields, the two consents unticked with the versioned texts, the
// synthetic-data line, the field errors, the real BFF refusing a mailbox-simulator address without
// creating anything, and the code step with the BFF's answers scripted in the page (a real code would
// need a person's mailbox).
import { type Page, expect, test } from "@playwright/test";
import { CURRENT_SIGNUP_CONSENT } from "@reclamo/bff/copy/signup-consent";
import { type PublicAnswer, type PublicCall, routePublicApi } from "../../src/lib/auth/testing/guest-e2e.ts";
import { AUTH_COPY } from "../../src/views/login/auth-copy.ts";
import { LANDING_COPY } from "../../src/views/landing/copy.ts";
import { type Lang, evidence, expectNeutralPage, expectNoHorizontalScroll, isPhone, sizeOf } from "./support/site";

const STRONG = "UnaClaveLarga2026";
/** A synthetic address of the SES mailbox simulator: the BFF must refuse it as a visitor's. */
const SIMULATOR = "success+qa-poc-surfaces@simulator.amazonses.com";
const SIGNUP_ID = "abcdefghijklmnopqrstuvwxyz";

async function openSignup(page: Page, lang: Lang): Promise<void> {
  await page.goto(lang === "en" ? "/signup?lang=en" : "/signup", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: AUTH_COPY[lang].signup.title })).toBeVisible({ timeout: 45_000 });
}

const termsBox = (page: Page, lang: Lang) => page.getByRole("checkbox", { name: new RegExp(AUTH_COPY[lang].signup.termsLink) });
const contactBox = (page: Page, lang: Lang) => page.getByRole("checkbox", { name: AUTH_COPY[lang].signup.consentContact });

test.describe("a browser that enforces the CSP", () => {
  for (const path of ["/signup", "/login/recover"] as const) {
    test(`[FL-112] ${path} shows its form through the edge, with no CSP violation`, async ({ page }) => {
      const blocked: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && /Content Security Policy/.test(message.text())) blocked.push(message.text().slice(0, 120));
      });
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `the edge answered the document ${response?.status()} ${(await response?.headerValue("x-amzn-waf-action")) ?? ""}`).toBe(200);
      const title = path === "/signup" ? AUTH_COPY.es.signup.title : AUTH_COPY.es.recover.title;
      await expect(page.getByRole("heading", { level: 1, name: title }), `CSP violations: ${blocked.join(" | ")}`).toBeVisible({ timeout: 45_000 });
      await expect(page.locator('form input[type="email"]').first()).toBeVisible();
      expect(blocked).toEqual([]);
    });
  }
});

test.describe("the open form", () => {
  for (const lang of ["es", "en"] as const) {
    test(`[FL-112] /signup ${lang}: the open form, its two unticked versioned consents and the synthetic line`, async ({ page }, info) => {
      const copy = AUTH_COPY[lang].signup;
      await openSignup(page, lang);
      await expect(page.getByLabel(copy.email, { exact: true })).toBeVisible();
      await expect(page.getByLabel(copy.password, { exact: true })).toHaveAttribute("type", "password");
      await expect(page.getByLabel(copy.name, { exact: true })).toBeVisible();
      await expect(page.getByLabel(copy.company, { exact: true })).toBeVisible();
      await expect(page.getByLabel(copy.role, { exact: true })).toBeVisible();
      // Never more than three optional fields (poc-landing §5).
      expect(await page.locator("form input:not([type=checkbox]), form select").count()).toBe(5);

      await expect(termsBox(page, lang)).not.toBeChecked();
      await expect(contactBox(page, lang)).not.toBeChecked();
      const [before, after] = CURRENT_SIGNUP_CONSENT.terms[lang].split("{terms}");
      const termsLabel = (before ?? "") + copy.termsLink + (after ?? "").replace("{privacy}", copy.privacyLink);
      await expect(page.locator("form label", { hasText: copy.termsLink })).toHaveText(termsLabel);
      await expect(page.locator("form label", { hasText: CURRENT_SIGNUP_CONSENT.contact[lang] })).toHaveText(CURRENT_SIGNUP_CONSENT.contact[lang]);
      await expect(page.locator("form").getByRole("link", { name: copy.termsLink })).toHaveAttribute("href", /^\/legal\/terms\.html/);
      await expect(page.locator("form").getByRole("link", { name: copy.privacyLink })).toHaveAttribute("href", /^\/legal\/privacy\.html/);
      await expect(page.getByText(copy.synthetic)).toBeVisible();
      await expect(page.getByRole("link", { name: copy.signIn })).toHaveAttribute("href", /^\/login/);
      await expectNoHorizontalScroll(page, `/signup ${lang}`);
      await expectNeutralPage(page, `/signup ${lang}`);
      await evidence(page, `signup-${lang}-${sizeOf(info)}`);
    });
  }

  test("[FL-112] /signup: the field errors, in the spec's words", async ({ page }) => {
    const copy = AUTH_COPY.es.signup;
    await openSignup(page, "es");
    await page.getByRole("button", { name: copy.submit }).click();
    await expect(page.getByRole("alert").first()).toHaveText(copy.errors.email);
    await expect(page.getByText(copy.errors.weakPassword)).toBeVisible();
    await expect(page.getByText(copy.errors.consent)).toBeVisible();
    await page.getByLabel(copy.email, { exact: true }).fill("no-es-un-email");
    await page.getByLabel(copy.password, { exact: true }).fill("corta");
    await page.getByRole("button", { name: copy.submit }).click();
    await expect(page.getByText(copy.errors.email)).toBeVisible();
    await expect(page.getByText(copy.errors.weakPassword)).toBeVisible();
  });

  test("[FL-112] the real BFF refuses a mailbox-simulator address as a visitor's (no account, no lead)", async ({ page }, info) => {
    test.skip(isPhone(info), "one real public POST per run (the edge allows 10 per 5 minutes)");
    const copy = AUTH_COPY.es.signup;
    await openSignup(page, "es");
    await page.getByLabel(copy.email, { exact: true }).fill(SIMULATOR);
    await page.getByLabel(copy.password, { exact: true }).fill(STRONG);
    await termsBox(page, "es").check();
    const answer = page.waitForResponse((response) => response.url().includes("/api/public/signup.start"));
    await page.getByRole("button", { name: copy.submit }).click();
    const response = await answer;
    expect(response.status()).toBe(200);
    expect(((await response.json()) as { result?: { data?: { status?: string } } }).result?.data?.status).toBe("INVALID_EMAIL");
    await expect(page.getByText(copy.errors.email)).toBeVisible();
    expect(page.url()).not.toContain("/signup/verify");
  });

  test("[FL-113] the code step after CODE_SENT carries the visit's campaign, locale and consents (answers scripted)", async ({ page }, info) => {
    const copy = AUTH_COPY.es;
    // The visit starts on the landing with a campaign and follows the product CTA.
    await page.goto("/?utm_source=qa-poc&utm_medium=e2e&utm_campaign=surfaces", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: LANDING_COPY.es.cta.try }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: copy.signup.title })).toBeVisible({ timeout: 45_000 });
    const calls = await routePublicApi(page, (call: PublicCall): PublicAnswer => {
      if (call.procedure === "signup.availability") return { data: { status: "open" } };
      if (call.procedure === "signup.start") return { data: { status: "CODE_SENT", signupId: SIGNUP_ID } };
      if (call.procedure === "signup.confirm") return { data: { status: "CODE_MISMATCH" } };
      return { http: 500, body: "unscripted" };
    });
    await page.getByLabel(copy.signup.email, { exact: true }).fill(SIMULATOR);
    await page.getByLabel(copy.signup.password, { exact: true }).fill(STRONG);
    await termsBox(page, "es").check();
    await contactBox(page, "es").check();
    await page.getByRole("button", { name: copy.signup.submit }).click();

    await expect(page).toHaveURL(/\/signup\/verify/);
    await expect(page.getByRole("heading", { level: 1, name: copy.verify.title })).toBeVisible();
    await expect(page.getByText(SIMULATOR)).toBeVisible();
    await expect(page.getByRole("button", { name: /Reenviar código \(\d+ s\)/ })).toBeDisabled();
    const start = calls.find((call) => call.procedure === "signup.start");
    expect(start?.method).toBe("POST");
    expect(start?.search ?? "", "nothing personal in a URL").toBe("");
    expect(start?.input).toMatchObject({ acceptTerms: true, acceptContact: true, locale: "es", utm: { source: "qa-poc", medium: "e2e", campaign: "surfaces" } });
    await expectNeutralPage(page, "/signup/verify");
    await evidence(page, `signup-verify-es-${sizeOf(info)}`);

    await page.getByLabel(copy.verify.code, { exact: true }).fill("123456");
    await page.getByRole("button", { name: copy.verify.submit }).click();
    await expect(page.getByText(copy.verify.mismatch)).toBeVisible();
    expect(calls.find((call) => call.procedure === "signup.confirm")?.input).toEqual({ signupId: SIGNUP_ID, code: "123456" });
  });
});
