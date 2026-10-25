// FL-096 · the register on the UI server (tests/ui-server): the real `appRouter` over the in-process
// `demo` world, its seeded register anchored in the world's anchor log. The view shows the chain
// verified, finds a complaint number, and exports a file that re-verifies without the stage (the same
// check as `npm run register:verify`), with its `.sha256` and no cell a spreadsheet would run. The
// partial and broken states cannot be produced from a browser (an overwrite needs the table and the
// anchor log), so those two answers of `register.verify` are the real one with its result replaced.
import { type Page, expect, test } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { parseCsv } from "../../bff/src/routers/csv.ts";
import { checkManifest, verifyExport } from "../../../scripts/register/verify.ts";
import { sessionTokens, staffClaims } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { registerCopy } from "../src/views/register/copy.ts";
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

/** Lets the BFF answer and replaces the fields of one procedure's answer (a batch keeps the others). */
async function patchAnswer(page: Page, procedure: string, patch: Record<string, unknown>): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const paths = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/api\//, "")).split(",");
    if (!paths.includes(procedure)) return route.fallback();
    const response = await route.fetch();
    const answers = (await response.json()) as { result?: { data: Record<string, unknown> } }[];
    const patched = answers.map((answer, index) => (paths[index] === procedure && answer.result ? { result: { data: { ...answer.result.data, ...patch } } } : answer));
    await route.fulfill({ response, json: patched });
  });
}

const statusOf = (page: Page) => page.locator("[data-chain-result]").first();

test.describe("register", () => {
  test("shows the register verified, finds a number and exports a file that re-verifies without the stage [FL-096]", async ({ page }) => {
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/register");
    await expect(page.getByRole("heading", { name: copy.views.register.title })).toBeVisible();
    await expect(statusOf(page)).toHaveAttribute("data-chain-result", "ok");
    await expect(statusOf(page)).toContainText(registerCopy.status.ok);
    await expect(statusOf(page)).toContainText(registerCopy.status.okGloss);

    const table = page.getByRole("table", { name: registerCopy.list.caption });
    await expect(table).toBeVisible();
    await expect(table.getByText(/^R-2026-\d{6}$/).first()).toBeVisible();
    await expect(page.getByText(/^seq \d+ a \d+ de \d+$/)).toBeVisible();

    await page.getByLabel(registerCopy.list.searchLabel).fill("r-2026-000001");
    await page.getByRole("button", { name: registerCopy.list.searchButton, exact: true }).click();
    await expect(table.getByText("R-2026-000001").first()).toBeVisible();
    for (const number of await table.locator("tbody td:nth-child(3)").allTextContents()) expect(number).toBe("R-2026-000001");
    await expect(table.getByText(registerCopy.events.FILED)).toBeVisible();
    await expect(table).toContainText("••••");

    await page.getByRole("button", { name: registerCopy.export.button }).click();
    const files = page.getByRole("region", { name: new RegExp(`^${registerCopy.export.heading} · `) });
    await expect(files.getByRole("link", { name: registerCopy.export.csv })).toBeVisible();
    const href = async (name: string) => (await files.getByRole("link", { name }).getAttribute("href")) ?? "";
    const csv = await (await page.request.get(await href(registerCopy.export.csv))).text();
    const json = await (await page.request.get(await href(registerCopy.export.json))).text();
    const sums = await (await page.request.get(await href(registerCopy.export.sha256))).text();

    expect(verifyExport(csv)).toMatchObject({ chain: "REG", worldId: "demo", declared: "ok", recomputed: "ok", consistent: true });
    expect(verifyExport(json)).toMatchObject({ declared: "ok", recomputed: "ok", consistent: true });
    const csvName = (await href(registerCopy.export.csv)).split("/").at(-1) ?? "";
    expect(checkManifest(sums, csvName, csv)).toBe(true);
    expect(parseCsv(csv).flat().filter((cell) => /^[=+\-@\t\r]/.test(cell))).toEqual([]);
  });

  test("says Parcial: N entradas sin ancla when the verification finds entries without an anchor [FL-096]", async ({ page }) => {
    await patchAnswer(page, "register.verify", { result: "partial", unanchored: [860, 861] });
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/register");
    await expect(statusOf(page)).toHaveAttribute("data-chain-result", "partial");
    await expect(statusOf(page)).toContainText("Parcial: 2 entradas sin ancla");
    await expect(statusOf(page)).toContainText("Partial: 2 entries without an anchor");
    await expect(statusOf(page)).not.toContainText(registerCopy.status.ok);
    await expect(page.getByText("860, 861")).toBeVisible();
  });

  test("says Rota en seq N when the verification finds a break [FL-096]", async ({ page }) => {
    await patchAnswer(page, "register.verify", { result: "broken", brokenAt: 7, breaks: [7] });
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/register");
    await expect(statusOf(page)).toHaveAttribute("data-chain-result", "broken");
    await expect(statusOf(page)).toContainText("Rota en seq 7");
    await expect(statusOf(page)).toContainText("Broken at seq 7");
  });

  test("lists the refund register with its amounts", async ({ page }) => {
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/register");
    await page.getByRole("group", { name: registerCopy.chains.label }).getByRole("button", { name: registerCopy.chains.RRI }).click();
    await expect(page.getByRole("heading", { name: registerCopy.chains.RRI })).toBeVisible();
    const table = page.getByRole("table", { name: registerCopy.list.caption });
    await expect(table.getByText(/^\$ [\d.]+,\d{2}$/).first()).toBeVisible();
    await expect(table.getByText(new RegExp(`${registerCopy.causes.REVERSE_CHARGE}|${registerCopy.causes.REFUND_DUPLICATE}|${registerCopy.causes.TRANSFER_REVERSAL}`)).first()).toBeVisible();
    await expect(statusOf(page)).toHaveAttribute("data-chain-result", "ok");
    await expect(page.getByRole("search")).toHaveCount(0);
  });
});
