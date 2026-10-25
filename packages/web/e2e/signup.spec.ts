// FL-112 to FL-116 and FL-118 · the self-signup in a real browser (docs/landing-spec.md §9.2-§9.3, §10
// cases 6 and 7): `/signup` with its consents unticked and the synthetic-data line, the field errors
// with the 12-character policy, EMAIL_TAKEN with its links, the replaced form, the caps (the BFF's and
// the edge's), the closed sign-up with only "Hablemos", the firewall's challenge, `/signup/verify` with
// the 30-second resend and the three refusals, and the two ways out of CONFIRMED: the silent sign-in
// to `/signup/provisioning` and then the inbox, or `/login` with the email pre-filled. The public
// procedures and Cognito are answered by page.route; the addresses are the SES mailbox simulator's.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralTerms } from "../../../scripts/lint/neutral-surfaces.ts";
import { type PublicAnswer, type PublicCall, EDGE_RATE_LIMITED, WAF_CHALLENGE, routePublicApi, selfSignupAuthResult, simulatorEmail, simulatorWorld } from "../src/lib/auth/testing/guest-e2e.ts";
import { AUTH_COPY } from "../src/views/login/auth-copy.ts";
import { contactHref } from "../src/views/landing/links.ts";
import { NOT_IMPLEMENTED, routeApi } from "./support/api-route";
import { PASSWORD_VERIFIER, routeCognito } from "./support/cognito-route";

const es = AUTH_COPY.es;
const en = AUTH_COPY.en;
const PASSWORD = "UnaClaveLarga2026";
const SIGNUP_A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGNUP_B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

type Script = Partial<Record<string, PublicAnswer | ((call: PublicCall) => PublicAnswer)>>;

async function publicApi(page: Page, script: Script): Promise<PublicCall[]> {
  return routePublicApi(page, (call) => {
    const entry = call.procedure === "signup.availability" ? (script[call.procedure] ?? { data: { status: "open" } }) : script[call.procedure];
    if (entry === undefined) return { http: 500, body: "unscripted" };
    return typeof entry === "function" ? entry(call) : entry;
  });
}

async function fillForm(page: Page, email: string, copy = es): Promise<void> {
  await page.getByLabel(copy.signup.email, { exact: true }).fill(email);
  await page.getByLabel(copy.signup.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox", { name: new RegExp(copy.signup.termsLink) }).check();
}

async function submit(page: Page, copy = es): Promise<void> {
  await page.getByRole("button", { name: copy.signup.submit }).click();
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function sessionText(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ ...window.sessionStorage }) + JSON.stringify({ ...window.localStorage }));
}

for (const viewport of VIEWPORTS) {
  test.describe(`sign-up end to end on a ${viewport.name} [FL-112] [FL-113]`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("[FL-112] [FL-113] form → code → silent sign-in → provisioning → inbox, with nothing personal in the URL or the storage", async ({ page }) => {
      const email = simulatorEmail("su1");
      const world = simulatorWorld("su1");
      // The world is READY from the poll that comes 3 s after the first one (the screen polls every 5 s).
      let firstStatusAt: number | undefined;
      await routeApi(page, (path) => {
        if (path !== "guest.status") return NOT_IMPLEMENTED;
        firstStatusAt ??= Date.now();
        return { data: { worldStatus: Date.now() - firstStatusAt < 3_000 ? "REGISTERED" : "READY", queuePosition: 0 } };
      });
      const calls = await publicApi(page, {
        "signup.start": { data: { status: "CODE_SENT", signupId: SIGNUP_A } },
        "signup.confirm": { data: { status: "CONFIRMED", worldStatus: "REGISTERED", email } },
      });
      const cognito = await routeCognito(page, { InitiateAuth: PASSWORD_VERIFIER, RespondToAuthChallenge: selfSignupAuthResult({ email, worldId: world, worldStatus: "REGISTERED" }) });

      await page.goto("/signup?utm_source=newsletter&utm_campaign=launch");
      await expect(page.getByRole("heading", { name: es.signup.title })).toBeVisible();
      for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
      await expect(page.getByText(es.signup.synthetic)).toBeVisible();
      expect(findNeutralTerms("/signup", await page.locator("body").innerText())).toEqual([]);
      await expectNoHorizontalScroll(page);

      await fillForm(page, email);
      await page.getByLabel(es.signup.company, { exact: true }).fill("Prestamista del Sur");
      await page.getByLabel(es.signup.role, { exact: true }).selectOption(es.signup.roles[3] ?? "");
      await submit(page);

      await page.waitForURL("**/signup/verify");
      const start = calls.find((call) => call.procedure === "signup.start");
      expect(start?.method).toBe("POST");
      expect(start?.input).toEqual({ email, password: PASSWORD, company: "Prestamista del Sur", jobTitle: es.signup.roles[3], acceptTerms: true, acceptContact: false, locale: "es", utm: { source: "newsletter", campaign: "launch" } });
      await expect(page.getByText(email)).toBeVisible();
      await expect(page.getByRole("button", { name: /Reenviar código \(\d+ s\)/ })).toBeDisabled();
      expect(page.url()).not.toContain(SIGNUP_A);
      const stored = await sessionText(page);
      expect(stored).toContain(SIGNUP_A);
      expect(stored).not.toContain(PASSWORD);

      await page.getByLabel(es.verify.code, { exact: true }).fill("123456");
      await page.getByRole("button", { name: es.verify.submit, exact: true }).click();
      await expect(page.getByRole("heading", { name: es.provisioning.preparingTitle })).toBeVisible();
      expect(page.url()).toContain("/signup/provisioning");
      await expect(page.getByText(es.provisioning.preparingLead)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.waitForURL("**/app/inbox", { timeout: 20_000 });
      await expect(page.getByText(email).first()).toBeVisible();

      expect(calls.find((call) => call.procedure === "signup.confirm")?.input).toEqual({ signupId: SIGNUP_A, code: "123456" });
      expect(cognito.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
      expect(JSON.parse(cognito[0]?.body ?? "{}")).toMatchObject({ AuthParameters: { USERNAME: email } });
      for (const call of cognito) expect(call.body).not.toContain(PASSWORD);
      for (const call of calls) expect(call.search).toBe("");
      expect(await sessionText(page)).not.toContain(SIGNUP_A);
    });
  });
}

test.describe("the code page [FL-113] [FL-114] [FL-115]", () => {
  test("[FL-113] without the password in memory (a reload), CONFIRMED opens /login with the email pre-filled and the notice", async ({ page }) => {
    const email = simulatorEmail("su2");
    await publicApi(page, { "signup.start": { data: { status: "CODE_SENT", signupId: SIGNUP_A } }, "signup.confirm": { data: { status: "CONFIRMED", worldStatus: "REGISTERED", email } } });
    const cognito = await routeCognito(page, {});
    await page.goto("/signup");
    await fillForm(page, email);
    await submit(page);
    await page.waitForURL("**/signup/verify");
    await page.reload();
    await expect(page.getByText(email)).toBeVisible();
    await page.getByLabel(es.verify.code, { exact: true }).fill("123 456");
    await page.getByRole("button", { name: es.verify.submit, exact: true }).click();
    await page.waitForURL("**/login?notice=confirmed");
    await expect(page.getByText(es.login.confirmed)).toBeVisible();
    const username = page.getByLabel(es.login.username, { exact: true });
    await expect(username).toHaveValue(email);
    await expect(username).toHaveAttribute("readonly", "");
    await username.click();
    await expect(username).not.toHaveAttribute("readonly", "");
    expect(cognito).toEqual([]);
  });

  test("[FL-114] [FL-115] resend waits 30 s; a wrong and an expired code say so; SIGNUP_RESTART goes back to /signup", async ({ page }) => {
    await page.clock.install();
    const confirms: PublicAnswer[] = [{ data: { status: "CODE_MISMATCH" } }, { data: { status: "CODE_EXPIRED" } }, { data: { status: "SIGNUP_RESTART" } }];
    const calls = await publicApi(page, {
      "signup.start": { data: { status: "CODE_SENT", signupId: SIGNUP_A } },
      "signup.resend": { data: { status: "CODE_SENT" } },
      "signup.confirm": () => confirms.shift() ?? { data: { status: "SIGNUP_RESTART" } },
    });
    await page.goto("/signup");
    await fillForm(page, simulatorEmail("su3"));
    await submit(page);
    await page.waitForURL("**/signup/verify");

    const resend = page.getByRole("button", { name: /Reenviar código/ });
    await expect(resend).toBeDisabled();
    await expect(resend).toHaveText(es.verify.resendIn(30));
    await page.clock.fastForward(31_000);
    await expect(resend).toBeEnabled();
    await resend.click();
    await expect(page.getByText(es.verify.resent)).toBeVisible();
    await expect(resend).toBeDisabled();
    expect(calls.filter((call) => call.procedure === "signup.resend").map((call) => call.input)).toEqual([{ signupId: SIGNUP_A }]);

    const code = page.getByLabel(es.verify.code, { exact: true });
    const confirm = page.getByRole("button", { name: es.verify.submit, exact: true });
    await code.fill("111111");
    await confirm.click();
    await expect(page.getByText(es.verify.mismatch)).toBeVisible();
    await code.fill("222222");
    await confirm.click();
    await expect(page.getByText(es.verify.expired)).toBeVisible();
    await code.fill("333333");
    await confirm.click();
    await page.waitForURL("**/signup?restart=1");
    await expect(page.getByText(es.signup.restart)).toBeVisible();
    expect(await sessionText(page)).not.toContain(SIGNUP_A);
  });
});

test.describe("the form's refusals [FL-112] [FL-116] [FL-118]", () => {
  test("[FL-112] field errors under their fields, the first one announced, with the 12-character policy", async ({ page }) => {
    const calls = await publicApi(page, {});
    await page.goto("/signup");
    await page.getByLabel(es.signup.password, { exact: true }).fill("Corta1");
    await submit(page);
    await expect(page.getByRole("alert")).toHaveText(es.signup.errors.email);
    await expect(page.getByText(es.signup.errors.weakPassword)).toBeVisible();
    await expect(page.getByText(es.signup.errors.consent)).toBeVisible();
    await page.getByLabel(es.signup.name, { exact: true }).fill("visitá www.algo");
    await submit(page);
    await expect(page.getByText(es.signup.errors.plainText)).toBeVisible();
    expect(calls.filter((call) => call.procedure === "signup.start")).toEqual([]);
  });

  test("[FL-116] EMAIL_TAKEN offers sign-in and recovery; an unconfirmed earlier form is replaced and only the new signupId confirms", async ({ page }) => {
    const answers: PublicAnswer[] = [{ data: { status: "EMAIL_TAKEN" } }, { data: { status: "CODE_SENT", signupId: SIGNUP_A } }, { data: { status: "CODE_SENT", signupId: SIGNUP_B } }];
    const calls = await publicApi(page, { "signup.start": () => answers.shift() ?? { http: 500 }, "signup.confirm": { data: { status: "CODE_MISMATCH" } } });
    await page.goto("/signup");
    await fillForm(page, simulatorEmail("su4"));
    await submit(page);
    await expect(page.getByText(es.signup.errors.taken)).toBeVisible();
    await expect(page.getByRole("link", { name: es.signup.errors.takenSignIn, exact: true })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: es.signup.errors.takenRecover })).toHaveAttribute("href", "/login/recover");

    await fillForm(page, simulatorEmail("su5"));
    await submit(page);
    await page.waitForURL("**/signup/verify");
    await page.getByRole("link", { name: es.verify.otherEmail }).click();
    await page.waitForURL("**/signup");
    await fillForm(page, simulatorEmail("su5"));
    await submit(page);
    await page.waitForURL("**/signup/verify");
    await page.getByLabel(es.verify.code, { exact: true }).fill("123456");
    await page.getByRole("button", { name: es.verify.submit, exact: true }).click();
    await expect(page.getByText(es.verify.mismatch)).toBeVisible();
    expect(calls.filter((call) => call.procedure === "signup.confirm").map((call) => call.input)).toEqual([{ signupId: SIGNUP_B, code: "123456" }]);
  });

  test("[FL-118] the BFF's caps and the edge's rate rule show the fixed text and nothing moves on", async ({ page }) => {
    const answers: PublicAnswer[] = [{ data: { status: "RATE_LIMITED" } }, EDGE_RATE_LIMITED];
    await publicApi(page, { "signup.start": () => answers.shift() ?? { http: 500 } });
    await page.goto("/signup");
    await fillForm(page, simulatorEmail("su6"));
    await submit(page);
    await expect(page.getByText(es.common.rateLimited)).toBeVisible();
    await submit(page);
    await expect(page.getByText(es.common.rateLimited)).toBeVisible();
    expect(page.url()).toMatch(/\/signup$/);
  });

  test("[FL-112] with the sign-up closed, the fixed notice with only 'Hablemos' to the contact form replaces the form", async ({ page }) => {
    await publicApi(page, { "signup.availability": { data: { status: "closed" } } });
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: es.signup.closed.title })).toBeVisible();
    await expect(page.getByRole("link", { name: es.signup.closed.talk })).toHaveAttribute("href", contactHref("signup-unavailable"));
    await expect(page.getByLabel(es.signup.email, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Pedí acceso|Request access/i)).toHaveCount(0);
  });

  test("[FL-112] a firewall challenge reloads the page once, keeping every field but the password", async ({ page }) => {
    const answers: PublicAnswer[] = [WAF_CHALLENGE, { data: { status: "CODE_SENT", signupId: SIGNUP_A } }];
    const calls = await publicApi(page, { "signup.start": () => answers.shift() ?? { http: 500 } });
    await page.goto("/signup?lang=en");
    const email = simulatorEmail("su7");
    await fillForm(page, email, en);
    await page.getByLabel(en.signup.company, { exact: true }).fill("Prestamista del Sur");
    const reload = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).searchParams.get("retry") === "1");
    await submit(page, en);
    await reload;
    await expect(page.getByLabel(en.signup.email, { exact: true })).toHaveValue(email);
    await expect(page.getByLabel(en.signup.company, { exact: true })).toHaveValue("Prestamista del Sur");
    await expect(page.getByLabel(en.signup.password, { exact: true })).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: new RegExp(en.signup.termsLink) })).toBeChecked();
    await page.getByLabel(en.signup.password, { exact: true }).fill(PASSWORD);
    await submit(page, en);
    await page.waitForURL("**/signup/verify?lang=en");
    expect(calls.filter((call) => call.procedure === "signup.start").map((call) => (call.input as { locale: string }).locale)).toEqual(["en", "en"]);
  });
});

test.describe("ways in [FL-112]", () => {
  test("[FL-112] the login's 'Try Reclamo en regla' is always there and opens /signup by a full page load", async ({ page }) => {
    await publicApi(page, {});
    await page.goto("/login");
    const link = page.getByRole("link", { name: es.login.tryIt });
    await expect(link).toBeVisible();
    const documentRequest = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/signup");
    await link.click();
    await documentRequest;
    await expect(page.getByRole("heading", { name: es.signup.title })).toBeVisible();
  });

  test("[FL-112] in English, with the switch, and the sign-up's email in the language of the form", async ({ page }) => {
    const calls = await publicApi(page, { "signup.start": { data: { status: "CODE_SENT", signupId: SIGNUP_A } } });
    await page.goto("/signup");
    await page.getByRole("button", { name: `${es.lang.label}: ${es.lang.switchTo}` }).click();
    await expect(page.getByRole("heading", { name: en.signup.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(findNeutralTerms("/signup?lang=en", await page.locator("body").innerText())).toEqual([]);
    await fillForm(page, simulatorEmail("su8"), en);
    await submit(page, en);
    await page.waitForURL("**/signup/verify?lang=en");
    await expect(page.getByRole("heading", { name: en.verify.title })).toBeVisible();
    expect((calls.find((call) => call.procedure === "signup.start")?.input as { locale: string }).locale).toBe("en");
  });
});
