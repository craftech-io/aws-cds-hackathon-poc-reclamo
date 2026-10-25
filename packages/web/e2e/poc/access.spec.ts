// FL-117 / FL-119 on the deployed stage · `/login` and the password recovery as a visitor opens them
// (docs/landing-spec.md §9.5-§9.6). The sign-in form in es and en with its links (recovery, the product
// CTA, the legal pages), a wrong password answered by the real Cognito with the neutral message, and the
// recovery's two screens with the real `password.forgot` answering the same neutral line for an
// address that has no account, all with the page's CSP enforced (the edge's rules on the recovery
// document count: docs/architecture-guests.md §8).
import { type Page, expect, test } from "@playwright/test";
import { AUTH_COPY } from "../../src/views/login/auth-copy.ts";
import { type Lang, evidence, expectNeutralPage, expectNoHorizontalScroll, isPhone, sizeOf } from "./support/site";

/** No account has this name: the SES mailbox simulator's, never a person's. */
const NOBODY = "success+qa-poc-nobody@simulator.amazonses.com";

async function openLogin(page: Page, lang: Lang): Promise<void> {
  await page.goto(lang === "en" ? "/login?lang=en" : "/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: AUTH_COPY[lang].login.title })).toBeVisible();
}

for (const lang of ["es", "en"] as const) {
  test(`[FL-117] /login ${lang}: the form, recovery, the product CTA and the legal pages`, async ({ page }, info) => {
    const copy = AUTH_COPY[lang];
    await openLogin(page, lang);
    await expect(page.getByLabel(copy.login.username, { exact: true })).toBeVisible();
    await expect(page.getByLabel(copy.login.password, { exact: true })).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: copy.login.submit, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: copy.login.forgot })).toHaveAttribute("href", /^\/login\/recover/);
    await expect(page.getByRole("link", { name: copy.login.tryIt })).toHaveAttribute("href", /^\/signup/);
    await expect(page.getByRole("link", { name: copy.legal.privacy, exact: true }).first()).toHaveAttribute("href", /^\/legal\/privacy\.html/);
    await expect(page.getByRole("link", { name: copy.legal.terms, exact: true }).first()).toHaveAttribute("href", /^\/legal\/terms\.html/);
    // The public login never lists the reserved guest user names.
    await expect(page.locator("body")).not.toContainText(/guest-\d{2}/);
    await expectNoHorizontalScroll(page, `/login ${lang}`);
    await expectNeutralPage(page, `/login ${lang}`);
    await evidence(page, `login-${lang}-${sizeOf(info)}`);
  });
}

test("[FL-117] a wrong password gets the neutral message from the real Cognito", async ({ page }, info) => {
  test.skip(isPhone(info), "one real sign-in attempt per run");
  const copy = AUTH_COPY.es;
  await openLogin(page, "es");
  await page.getByLabel(copy.login.username, { exact: true }).fill(NOBODY);
  await page.getByLabel(copy.login.password, { exact: true }).fill("NoEsLaClave2026");
  await page.getByRole("button", { name: copy.login.submit, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(copy.errors.INVALID_CREDENTIALS);
  expect(page.url()).toContain("/login");
});

test.describe("recovery", () => {
  for (const lang of ["es", "en"] as const) {
    test(`[FL-119] /login/recover ${lang}: the two screens and the neutral answer`, async ({ page }, info) => {
      const copy = AUTH_COPY[lang].recover;
      await page.goto(lang === "en" ? "/login/recover?lang=en" : "/login/recover", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText(copy.lead)).toBeVisible();
      await expectNeutralPage(page, `/login/recover ${lang}`);
      await expectNoHorizontalScroll(page, `/login/recover ${lang}`);
      await evidence(page, `recover-${lang}-${sizeOf(info)}`);
      // One real public POST per run: es on the desktop; the other runs stop at the first screen.
      if (lang !== "es" || isPhone(info)) return;

      await page.getByLabel(copy.email, { exact: true }).fill(NOBODY);
      const answer = page.waitForResponse((response) => response.url().includes("/api/public/password.forgot"));
      await page.getByRole("button", { name: copy.submit }).click();
      const response = await answer;
      expect(((await response.json()) as { result?: { data?: { status?: string } } }).result?.data?.status).toBe("CODE_SENT_IF_EXISTS");
      await expect(page).toHaveURL(/\/login\/recover\/reset/);
      await expect(page.getByRole("heading", { level: 1, name: copy.resetTitle })).toBeVisible();
      await expect(page.getByText(copy.neutral)).toBeVisible();
      await expect(page.getByLabel(copy.code, { exact: true })).toBeVisible();
      await expect(page.getByLabel(copy.newPassword, { exact: true })).toBeVisible();
      await expect(page.getByLabel(copy.confirmPassword, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: copy.save })).toBeVisible();
      expect(new URL(page.url()).search, "nothing personal in a URL").not.toContain("simulator");
      await expectNeutralPage(page, "/login/recover/reset es");
      await evidence(page, `recover-reset-es-${sizeOf(info)}`);
    });
  }
});
