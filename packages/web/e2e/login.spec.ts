// FL-094 · own login, roles and 15-minute tokens, on the console alone (Cognito scripted, no AWS).
import { expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { loginCopy } from "../src/views/login/copy.ts";
import { NOT_IMPLEMENTED, WORLD_RESETTING, routeApi } from "./support/api-route";
import { PASSWORD_VERIFIER, routeCognito, tokensAnswer } from "./support/cognito-route";
import { PORTS } from "./support/env";
import { TOKENS_KEY, plantSession, replaceSession } from "./support/session";

// Fixture password of a scripted pool: it only ever reaches page.route.
const PASSWORD = "Fixture-Password-1!";

test.describe("login [FL-094]", () => {
  test("signs in with a username (no email, no forgot link) and keeps the tokens in sessionStorage only", async ({ page }) => {
    const calls = await routeCognito(page, {
      InitiateAuth: PASSWORD_VERIFIER,
      RespondToAuthChallenge: tokensAnswer({ username: "operator-01", role: "OPERATOR", worldId: "demo" }),
    });
    await page.goto("/login");
    await expect(page.getByLabel(loginCopy.credentials.username)).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.getByText(/olvidé/i)).toHaveCount(0);

    await page.getByLabel(loginCopy.credentials.username).fill("Operator-01");
    await page.getByLabel(loginCopy.credentials.password).fill(PASSWORD);
    await page.getByRole("button", { name: loginCopy.credentials.submit }).click();

    await page.waitForURL("**/app/inbox");
    await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible();
    await expect(page.getByText(`${copy.app.worldLabel}: demo`)).toBeVisible();
    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of calls) expect(call.body).not.toContain(PASSWORD);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AuthParameters: { USERNAME: "operator-01" } });
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key) !== null, TOKENS_KEY)).toBe(true);
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  });

  test("a guest lands in its own world with the demo views and no compliance-only restriction", async ({ page }) => {
    await plantSession(page, { username: "guest-03", role: "GUEST", worldId: "g03" });
    await page.goto("/app/inbox");
    await expect(page.getByText(`${copy.app.worldLabel}: g03`)).toBeVisible();
    await expect(page.getByRole("link", { name: copy.views.simulator.title })).toBeVisible();
  });

  test("compliance does not see the hands-on views and gets the forbidden screen there", async ({ page }) => {
    await plantSession(page, { username: "compliance-01", role: "COMPLIANCE", worldId: "demo" });
    await page.goto("/app/inbox");
    await expect(page.getByRole("link", { name: copy.views.tape.title })).toBeVisible();
    await expect(page.getByRole("link", { name: copy.views.approvals.title })).toHaveCount(0);
    await page.goto("/app/approvals");
    await expect(page.getByRole("heading", { name: copy.errors.forbiddenTitle })).toBeVisible();
  });

  test("token A replaced by B without a reload: the session follows B and does not end at A's exp", async ({ page }) => {
    // A is past its exp (with the 30 s skew) about 5 s from now; B lives 15 minutes.
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo", expiresIn: 35 });
    await page.goto("/app/inbox");
    await expect(page.getByText("operator-01")).toBeVisible();
    await replaceSession(page, { username: "operator-02", role: "OPERATOR", worldId: "demo", expiresIn: 900 });
    await expect(page.getByText("operator-02")).toBeVisible();
    await page.waitForTimeout(8_000);
    await expect(page).toHaveURL(/\/app\/inbox$/);
  });

  test("a session without a refresh token ends at its stored exp, without trying to refresh", async ({ page }) => {
    const calls = await routeCognito(page, {});
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo", expiresIn: 32 });
    await page.goto("/app/inbox");
    await page.waitForURL("**/login**", { timeout: 20_000 });
    await expect(page.getByText(loginCopy.credentials.sessionExpired)).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("signing out revokes the refresh token, clears the session and goes back to the landing", async ({ page }) => {
    const calls = await routeCognito(page, { RevokeToken: { body: {} } });
    await plantSession(page, { username: "operator-01", role: "OPERATOR", worldId: "demo" }, "e2e-refresh");
    await page.goto("/app/inbox");
    await page.getByRole("button", { name: copy.app.signOut }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect.poll(() => calls.map((call) => call.operation)).toEqual(["RevokeToken"]);
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), TOKENS_KEY)).toBeNull();
  });

  test("a world being reset shows the fixed screen, polls clock.resetStatus every 3 s and comes back on READY", async ({ page }) => {
    let ready = false;
    const calls = await routeApi(page, (path) => {
      if (path === "clock.resetStatus") {
        ready = calls.filter((call) => call.path === path).length >= 2;
        return { data: { status: ready ? "READY" : "RESETTING", phase: "WIPE" } };
      }
      if (!ready) return WORLD_RESETTING;
      if (path === "clock.get") return { data: { mode: "PAUSED", simNow: "2026-10-07T10:10:00-03:00" } };
      return NOT_IMPLEMENTED;
    });
    await plantSession(page, { username: "guest-03", role: "GUEST", worldId: "g03" });
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { name: copy.shell.resettingTitle })).toBeVisible();
    await expect(page.getByText(copy.shell.resettingLead)).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.views.inbox.title })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("mié 07/10 10:10")).toBeVisible();
    const polls = calls.filter((call) => call.path === "clock.resetStatus").map((call) => call.atMs);
    expect(polls).toHaveLength(2);
    expect((polls[1] ?? 0) - (polls[0] ?? 0)).toBeGreaterThanOrEqual(2_900);
  });

  test("a build without Cognito variables says so instead of offering a login that cannot work", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORTS.unconfigured}/login`);
    await expect(page.getByRole("heading", { name: copy.login.unconfiguredTitle })).toBeVisible();
  });
});
