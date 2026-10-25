// FL-113, FL-120, FL-126 and FL-117 on the deployed stage · the QA self-signup end to end (docs/test-plan.md
// SC-24/1-2, /7 and /12): sign-up and confirmation through the QaDriver (the real service, Cognito and the
// deployed triggers, with the run's own SES-simulator address), the world provisioned by the real
// factory, the provisioning screen in the browser with the account's session until READY, the console,
// "Salir" back to the landing, the QA lead (consents with version and instant, locale, campaign,
// sign-up and last sign-in) and the lead notice's real SES transport (`notice.probe`, to the SES mailbox
// simulator only). The account's password is generated and used inside the Lambda, so the
// browser receives the session the way SC-22/SC-24 plant it (sessionStorage before the app boots).
//
// Runs only with POC_QA_SIGNUP=1 inside `sst shell --stage poc` (it writes through the QaDriver, which
// the operator's profile may invoke); no agent turn, no Bedrock call. The QA world and account expire by
// themselves (6 h, docs/architecture-guests.md §6).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "@playwright/test";
import { CURRENT_SIGNUP_CONSENT } from "@reclamo/bff/copy/signup-consent";
import { copy as consoleCopy } from "../../src/copy/console.ts";
import { TOKENS_KEY } from "../../src/lib/auth/tokens.ts";
import { AUTH_COPY } from "../../src/views/login/auth-copy.ts";
import { LANDING_COPY } from "../../src/views/landing/copy.ts";
import { type GuestTokens, QA_UTM, claimOf, confirm, newRunId, noticeEvidence, noticeProbe, probeEvidence, readLead, redactLead, session, signUp, worldOf } from "./support/qa-guest";
import { EVIDENCE_DIR, SITE, VIEWPORTS, evidence, expectNeutralPage, expectNoHorizontalScroll } from "./support/site";

test.skip(process.env.POC_QA_SIGNUP !== "1", "writes through the QaDriver: POC_QA_SIGNUP=1 inside sst shell --stage poc");
test.describe.configure({ mode: "serial" });

/** FL-120's budget for a world (docs/landing-spec.md §9.4). */
const READY_WITHIN_MS = 600_000;

const state: { runId?: string; signupId?: string; sub?: string; confirmedAt?: number; readyAt?: number; consoleAt?: number; tokens?: GuestTokens } = {};

async function planted(browser: Browser, tokens: GuestTokens, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, locale: "es-AR" });
  await context.addInitScript(
    ({ key, value }) => {
      if (sessionStorage.getItem("reclamo.qa.planted") !== null) return;
      sessionStorage.setItem("reclamo.qa.planted", "1");
      sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify({ idToken: tokens.idToken, accessToken: tokens.accessToken, expiresAt: tokens.exp * 1_000 }) },
  );
  return context.newPage();
}

test("[FL-112/FL-113] QA sign-up and confirmation through the deployed service and triggers", async ({}, info) => {
  test.skip(info.project.name !== "desktop", "one account per run");
  state.runId = newRunId();
  state.signupId = await signUp(state.runId);
  // No sign-in before the confirmation: `guest.session` refuses an UNCONFIRMED account (`NOT_CONFIRMED`), so
  // only `guest.confirm` confirms it, through the real post-confirmation trigger.
  const worldStatus = await confirm(state.runId, state.signupId);
  state.confirmedAt = Date.now();
  expect(["REGISTERED", "CREATING", "READY"]).toContain(worldStatus);
});

test("[FL-120] the provisioning screen, then READY and the console", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" || state.runId === undefined, "after the sign-up");
  test.setTimeout(READY_WITHIN_MS + 180_000);
  const runId = state.runId as string;
  let attempt = 1;
  let tokens = await session(runId, attempt);
  state.sub = String(claimOf(tokens.idToken, "sub"));
  expect(claimOf(tokens.idToken, "worldId")).toBe(worldOf(runId));
  expect(claimOf(tokens.idToken, "role")).toBe("GUEST");
  expect(claimOf(tokens.idToken, "cognito:groups"), "a self-signup account is in no group").toBeUndefined();

  let page = await planted(browser, tokens, VIEWPORTS.desktop);
  await page.goto(`${SITE}/signup/provisioning`, { waitUntil: "domcontentloaded" });
  const auth = AUTH_COPY.es.provisioning;
  if (tokens.worldStatus !== "READY") {
    await expect(page.getByRole("heading", { level: 1 })).toContainText(auth.preparingTitle);
    await expectNeutralPage(page, "/signup/provisioning");
    await evidence(page, "provisioning-es-1440x900");
  }
  // The screen polls guest.status and opens the inbox by itself at READY; a session near its end is re-issued.
  const deadline = (state.confirmedAt ?? Date.now()) + READY_WITHIN_MS;
  while (!/\/app\/inbox/.test(page.url())) {
    expect(Date.now(), `the world was not READY within ${READY_WITHIN_MS / 1000} s of the confirmation`).toBeLessThan(deadline);
    await page.waitForURL(/\/app\/inbox/, { timeout: 60_000 }).catch(() => undefined);
    if (/\/app\/inbox/.test(page.url())) break;
    if (tokens.exp * 1_000 - Date.now() < 180_000) {
      attempt += 1;
      tokens = await session(runId, attempt);
      await page.context().close();
      page = await planted(browser, tokens, VIEWPORTS.desktop);
      await page.goto(`${SITE}/signup/provisioning`, { waitUntil: "domcontentloaded" });
    }
  }
  state.readyAt = Date.now();
  test.info().annotations.push({ type: "signupToReadyMs", description: String(state.readyAt - (state.confirmedAt ?? state.readyAt)) });

  await expect(page.getByRole("heading", { level: 1, name: consoleCopy.views.inbox.title })).toBeVisible({ timeout: 60_000 });
  // The header names the signed-in account and its own world, GUEST; no other run's world or address appears.
  await expect(page.locator("body")).toContainText(`${consoleCopy.app.roleLabel}: ${consoleCopy.roles.GUEST}`);
  const shownWorlds = (await page.locator("body").innerText()).match(/qa-\d+-\d+-su\d+/g) ?? [];
  expect(new Set(shownWorlds), "only the account's own world").toEqual(new Set([worldOf(runId)]));
  expect(((await page.locator("body").innerText()).match(/success\+qa-[\w-]+@/g) ?? []).every((address) => address.includes(runId)), "only the account's own address").toBe(true);
  await expectNoHorizontalScroll(page, "console inbox");
  await expectNeutralPage(page, "console inbox");
  state.consoleAt = Date.now();
  await evidence(page, "console-inbox-guest-1440x900");

  const phone = await planted(browser, await session(runId, attempt + 1), VIEWPORTS.phone);
  await phone.goto(`${SITE}/app/inbox`, { waitUntil: "domcontentloaded" });
  await expect(phone.getByRole("heading", { level: 1, name: consoleCopy.views.inbox.title })).toBeVisible({ timeout: 60_000 });
  await expectNoHorizontalScroll(phone, "console inbox 390");
  await evidence(phone, "console-inbox-guest-390x844");
  await phone.context().close();

  // "Salir" (FL-117, docs/landing-spec.md §9.7): the session is gone and the visitor is back on the landing.
  await page.getByRole("button", { name: consoleCopy.app.signOut }).first().click();
  await expect(page).toHaveURL(`${SITE}/`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: LANDING_COPY.es.cta.try }).first()).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKENS_KEY)).toBeNull();
  await page.goto(`${SITE}/app/inbox`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/login/);
  await page.context().close();
});

test("[FL-126] the QA lead: test flag, consents with version and instant, locale, campaign, sign-up and last sign-in", async ({}, info) => {
  test.skip(info.project.name !== "desktop" || state.sub === undefined, "after the console");
  const runId = state.runId as string;
  const lead = await readLead(runId, state.sub as string);
  expect(lead, "the QA lead exists").toBeDefined();
  if (!lead) return;
  const notices = await noticeEvidence(new Date().toISOString().slice(0, 7));
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, "test-lead.json"),
    `${JSON.stringify({ runId, world: worldOf(runId), checkedAt: new Date().toISOString(), lead: redactLead(lead), noticeAuditThisMonth: notices }, null, 2)}\n`,
    { mode: 0o600 },
  );

  expect(lead.qa).toEqual({ runId, key: "su1" });
  expect(lead.worldId).toBe(worldOf(runId));
  expect(lead.sourcePoc.length).toBeGreaterThan(0);
  expect(lead.locale).toBe("es");
  expect(lead.consents.terms.textVersion).toBe(CURRENT_SIGNUP_CONSENT.version);
  expect(Date.parse(lead.consents.terms.acceptedAtReal)).not.toBeNaN();
  expect(lead.consents.contact).toMatchObject({ accepted: true, textVersion: CURRENT_SIGNUP_CONSENT.version });
  expect(Date.parse(lead.consents.contact.atReal ?? "")).not.toBeNaN();
  expect(Date.parse(lead.signupAtReal)).toBeLessThanOrEqual(Date.parse(lead.confirmedAtReal));
  expect(lead.notifiedAtReal, "a QA lead is never notified").toBeUndefined();
  // What the CTO's lead definition asks of every lead, the QA one included.
  expect(lead.utm).toMatchObject(QA_UTM);
  expect(Date.parse(lead.lastLoginAtReal ?? ""), "the console session did not record the last sign-in of the QA lead").toBeGreaterThanOrEqual(Date.parse(lead.confirmedAtReal));
  // The notice path for real leads: the mailbox is a Craftech one; the first real LEAD_NOTICE_SENT is the operator's to confirm.
  // A QA lead is never notified, so a count of zero only means no real visitor has signed up this month:
  // reported, not failed, so the transport probe below still runs.
  expect(notices.mailboxIsCraftech, "LeadNotifyEmail is not a @craftech.io mailbox").toBe(true);
  test.info().annotations.push({ type: "leadNoticesSentThisMonth", description: String(notices.sent) });
});

test("[FL-126] the lead notice's real SES transport, proved against the mailbox simulator (notice.probe)", async ({}, info) => {
  test.skip(info.project.name !== "desktop" || state.runId === undefined, "after the sign-up");
  const month = new Date().toISOString().slice(0, 7);
  const before = (await probeEvidence(month))["SENT"] ?? 0;
  expect(await noticeProbe(state.runId as string)).toEqual({ outcome: "SENT", recipient: "SES_MAILBOX_SIMULATOR" });
  expect((await probeEvidence(month))["SENT"] ?? 0).toBe(before + 1);
});
