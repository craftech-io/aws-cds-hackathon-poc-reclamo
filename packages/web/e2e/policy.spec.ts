// FL-075 · the channel policy on the UI server (tests/ui-server): the rules the gate decides with, in
// order, with their versions, English gloss and "nuestra lectura, no asesoramiento legal"; the world's
// channel modes and parameters; and the agent cut-off of `demo`, which only a SUPERVISOR with a recent
// sign-in turns on and off (the BFF enforces it; routers/roles.ts). The cut is global, so the test that
// turns it on lifts it right away and, whatever happens, lifts it again through the API.
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { sessionTokens, staffClaims } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { policyCopy } from "../src/views/policy/copy.ts";
import { TOKENS_KEY } from "./support/session";

const TWENTY_MINUTES = 20 * 60;

async function signIn(page: Page, worldId: string, role: StaffRole, signedInAgo = 0): Promise<void> {
  const tokens = sessionTokens(staffClaims(worldId, role, { signedInAgo }));
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(tokens) },
  );
}

function bearer(worldId: string, role: StaffRole) {
  return { authorization: `Bearer ${sessionTokens(staffClaims(worldId, role)).idToken}` };
}

async function agentCut(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/policy.modes", { headers: bearer("demo", "COMPLIANCE") });
  const body = (await response.json()) as { result: { data: { agentKill: { global: boolean } } } };
  return body.result.data.agentKill.global;
}

test.describe("channel policy", () => {
  test.describe.configure({ mode: "serial" });

  test("every role reads the rules in order with their version, gloss and not-legal-advice line [FL-075]", async ({ page }) => {
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/policy");
    await expect(page.getByRole("heading", { name: copy.views.policy.title })).toBeVisible();
    await expect(page.getByText("Nuestra lectura de las reglas, no asesoramiento legal")).toBeVisible();
    await expect(page.getByText("Our reading of the rules, not legal advice")).toBeVisible();
    await expect(page.getByText(/^ch-\d{4}\.\d{2}\.\d{2}$/)).toBeVisible();

    const rules = page.getByRole("table", { name: policyCopy.rules.caption });
    const ids = await rules.locator("tbody tr td:first-child").allTextContents();
    expect(ids[0]).toBe("CH-SENDER");
    expect(ids.slice(0, 16).every((id) => id.startsWith("CH-"))).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(["CH-WA-NO-COLLECTION", "CH-RECIPIENT-FENCE", "CH-FORMAL-CONTENT", "G2", "VERIFY"]));
    const collection = rules.getByRole("row").filter({ hasText: "CH-WA-NO-COLLECTION" });
    await expect(collection).toContainText("Política comercial de WhatsApp (cobro de deudas)");
    await expect(collection.locator('[lang="en"]')).toContainText("WhatsApp Commerce Policy (debt collection)");

    const modes = page.getByRole("region", { name: policyCopy.modes.title });
    await expect(modes).toContainText(policyCopy.modes.emailMode);
    await expect(modes).toContainText(policyCopy.modes.simulated);
    const parameters = page.getByRole("region", { name: policyCopy.parameters.title });
    await expect(parameters).toContainText(policyCopy.parameters.formalNotice);
    await expect(parameters).toContainText(policyCopy.parameters.assumption);
    await expect(parameters).toContainText(policyCopy.capActions.APPLY_PAYMENT);

    const agent = page.getByRole("region", { name: policyCopy.kill.title });
    await expect(agent).toContainText(policyCopy.kill.inactive);
    await expect(agent).toContainText(policyCopy.kill.onlySupervisor);
    await expect(agent.getByRole("button")).toHaveCount(0);
  });

  test("a SUPERVISOR of demo cuts the agent in two steps and lifts the cut, without a deploy", async ({ page, request }) => {
    try {
      await signIn(page, "demo", "SUPERVISOR");
      await page.goto("/app/policy");
      const agent = page.getByRole("region", { name: policyCopy.kill.title });
      await agent.getByRole("button", { name: policyCopy.kill.cut }).click();
      expect(await agentCut(request)).toBe(false);
      await agent.getByLabel(policyCopy.kill.reason).fill("Prueba del corte desde la consola");
      await agent.getByRole("button", { name: policyCopy.kill.confirmCut }).click();
      await expect(agent.getByText(policyCopy.kill.doneOn)).toBeVisible();
      await expect(agent.getByText(/^Agente cortado desde /)).toBeVisible();
      expect(await agentCut(request)).toBe(true);

      await agent.getByRole("button", { name: policyCopy.kill.lift }).click();
      await agent.getByRole("button", { name: policyCopy.kill.confirmLift }).click();
      await expect(agent.getByText(policyCopy.kill.doneOff)).toBeVisible();
      await expect(agent.getByText(policyCopy.kill.inactive)).toBeVisible();
      expect(await agentCut(request)).toBe(false);
    } finally {
      await request.post("/api/policy.setAgentKill", { headers: bearer("demo", "SUPERVISOR"), data: { on: false } });
    }
  });

  test("with a sign-in older than 15 minutes the step-up opens and nothing is sent", async ({ page, request }) => {
    await signIn(page, "demo", "SUPERVISOR", TWENTY_MINUTES);
    await page.goto("/app/policy");
    const agent = page.getByRole("region", { name: policyCopy.kill.title });
    await agent.getByRole("button", { name: policyCopy.kill.cut }).click();
    await agent.getByRole("button", { name: policyCopy.kill.confirmCut }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(agent.getByText(policyCopy.kill.recent)).toBeVisible();
    expect(await agentCut(request)).toBe(false);
  });

  test("a GUEST reads the state of the cut and the rules but gets no control", async ({ page }) => {
    await signIn(page, "g03", "GUEST");
    await page.goto("/app/policy");
    const agent = page.getByRole("region", { name: policyCopy.kill.title });
    await expect(agent).toContainText(policyCopy.kill.inactive);
    await expect(agent.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("table", { name: policyCopy.rules.caption })).toBeVisible();
  });
});
