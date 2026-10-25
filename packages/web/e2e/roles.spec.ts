// FL-095 · compliance is read-only, on the UI server (tests/ui-server): a COMPLIANCE session of `demo`
// reads the tape, the register, the emails, the metrics and the policy completely and sees no button
// that changes anything; and the real BFF refuses every mutation it is sent directly, whatever the
// console shows (routers/roles.ts). The agent cut-off is refused to every role but a SUPERVISOR of demo.
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { sessionTokens, staffClaims } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { ROUTES, routeAllows, routeTitle } from "../src/routes.ts";
import { TOKENS_KEY } from "./support/session";

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

async function mutate(request: APIRequestContext, worldId: string, role: StaffRole, path: string, input: unknown) {
  const response = await request.post(`/api/${path}`, { headers: { authorization: `Bearer ${sessionTokens(staffClaims(worldId, role)).idToken}` }, data: input });
  const body = (await response.json()) as { error?: { data?: { code?: string; reason?: string | null } } };
  return { status: response.status(), code: body.error?.data?.code, reason: body.error?.data?.reason ?? null };
}

/** Labels of every button that would change the world, the agent or a customer's case. */
const MUTATIONS = /Cortar|Levantar|Enviar|Aprobar|Rechazar|Responder|Tomar|Devolver|Derivar|Reiniciar|Avanzar|Disparar|Confirmar|Mandar|Adjuntar/i;

const READ_VIEWS = [
  { path: "/app/tape", title: copy.views.tape.title },
  { path: "/app/register", title: copy.views.register.title },
  { path: "/app/emails", title: copy.views.emails.title },
  { path: "/app/metrics", title: copy.views.metrics.title },
  { path: "/app/policy", title: copy.views.policy.title },
] as const;

test.describe("roles", () => {
  for (const view of READ_VIEWS) {
    test(`compliance reads ${view.path} without any button that changes something [FL-095]`, async ({ page }) => {
      await signIn(page, "demo", "COMPLIANCE");
      await page.goto(view.path);
      await expect(page.getByRole("heading", { name: view.title, level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: copy.shell.readOnlyClock })).toBeVisible();
      await page.waitForLoadState("networkidle");
      const main = page.getByRole("main");
      await expect(main.getByRole("button", { name: MUTATIONS })).toHaveCount(0);
      for (const button of await page.getByRole("button", { name: /Avanzar|\+1/ }).all()) await expect(button).toBeDisabled();
      await expect(page.getByRole("link", { name: copy.views.approvals.title })).toHaveCount(0);
      await expect(page.getByRole("link", { name: copy.views.simulator.title })).toHaveCount(0);
    });
  }

  test("the BFF refuses every mutation of compliance even when it is called directly [FL-095]", async ({ request }) => {
    const attempts = [
      ["policy.setAgentKill", { on: true }],
      ["customers.compose", { customerId: "cus-0009", kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Regularizá hoy." }],
      ["conversation.reroute", { tapeId: "tp-l000001", route: "FORMAL_EMAIL", customerId: "cus-0009" }],
      ["clock.advance", { minutes: 60 }],
      ["approvals.decide", { approvalId: "apr-0001", decision: "APPROVE" }],
    ] as const;
    for (const [path, input] of attempts) {
      const refused = await mutate(request, "demo", "COMPLIANCE", path, input);
      expect({ path, status: refused.status, code: refused.code }).toEqual({ path, status: 403, code: "FORBIDDEN" });
      expect(["READ_ONLY_ROLE", "ROLE_NOT_ALLOWED"]).toContain(refused.reason);
    }
    const modes = await request.get("/api/policy.modes", { headers: { authorization: `Bearer ${sessionTokens(staffClaims("demo", "COMPLIANCE")).idToken}` } });
    expect(((await modes.json()) as { result: { data: { agentKill: { global: boolean } } } }).result.data.agentKill.global).toBe(false);
  });

  test("the agent cut-off is refused to an operator of demo and to a guest [FL-095]", async ({ request }) => {
    for (const [worldId, role] of [
      ["demo", "OPERATOR"],
      ["g03", "GUEST"],
    ] as const) {
      const refused = await mutate(request, worldId, role, "policy.setAgentKill", { on: true });
      expect({ worldId, status: refused.status, reason: refused.reason }).toEqual({ worldId, status: 403, reason: "ROLE_NOT_ALLOWED" });
    }
  });

  test("on a phone (390x844) the menu reaches every view of the role, with Esc to close and the focus kept inside", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "demo", "OPERATOR");
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { name: copy.views.inbox.title, level: 1 })).toBeVisible();
    const menu = page.getByRole("button", { name: copy.nav.menu });
    const routes = ROUTES.filter((route) => route.nav && routeAllows(route, "OPERATOR"));
    expect(routes.length).toBeGreaterThan(5);

    await menu.click();
    const drawer = page.getByRole("dialog", { name: copy.nav.menuTitle });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    for (const route of routes) {
      await menu.click();
      await page.getByRole("dialog", { name: copy.nav.menuTitle }).getByRole("link", { name: routeTitle(route) }).click();
      await expect(page).toHaveURL(new RegExp(`${route.path}$`));
      await expect(page.getByRole("heading", { name: routeTitle(route), level: 1 })).toBeVisible();
      await expect(page.getByRole("dialog", { name: copy.nav.menuTitle })).toHaveCount(0);
    }
  });
});
