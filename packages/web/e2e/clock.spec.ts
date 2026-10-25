// FL-082 · FL-100 · the demo clock (`/app/clock`) of a guest's own world, on the console alone: the BFF
// is answered from the page (support/api-route.ts) with the shapes of `clock.*`, so every case — a busy
// world, a refused move, a reset that takes a while — is reproducible. Nothing leaves the machine.
import { type Page, type Request, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { clockCopy } from "../src/views/clock/copy.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, WORLD_RESETTING, refusal, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

const GUEST = { username: "guest-03", role: "GUEST", worldId: "g03" } as const;
const START = "2026-10-07T10:10:00-03:00";

function clockAnswer(overrides: Record<string, unknown> = {}) {
  return {
    worldId: "g03",
    worldEpoch: 1,
    mode: "PAUSED",
    simNow: START,
    upcoming: [
      { kind: "SETTLEMENT_PUBLISH", timerId: "NORTE-2026-10-07", dueAtSim: "2026-10-08T08:30:00-03:00", ownerKey: "BATCH#NORTE#2026-10-07", complaintId: null },
      { kind: "SLA", timerId: "cmp-h000120-OPERATOR_REMINDER", dueAtSim: "2026-10-14T10:00:00-03:00", ownerKey: "CMP#cmp-h000120", complaintId: "cmp-h000120" },
    ],
    busy: null,
    ...overrides,
  };
}

const MOVED = { worldId: "g03", mode: "PAUSED", fromSim: START, simNow: "2026-10-08T08:30:00-03:00", worldEpoch: 1, fired: [{ kind: "SETTLEMENT_PUBLISH", timerId: "NORTE-2026-10-07", dueAtSim: "2026-10-08T08:30:00-03:00", status: "FIRED" }], forced: false };

/** The input of a tRPC call as the console's batch link posts it. */
function inputOf(request: Request): unknown {
  const body = request.postDataJSON() as Record<string, unknown> | null;
  return body?.["0"];
}

async function openClock(page: Page, script: (path: string) => ApiAnswer) {
  const calls = await routeApi(page, script);
  await plantSession(page, GUEST);
  await page.goto("/app/clock");
  await expect(page.getByRole("heading", { name: copy.views.clock.title })).toBeVisible();
  return calls;
}

test.describe("the demo clock [FL-082]", () => {
  test("[FL-082] shows the world's hour, its mode and the upcoming events in words, never raw codes", async ({ page }) => {
    await openClock(page, (path) => (path === "clock.get" ? { data: clockAnswer() } : NOT_IMPLEMENTED));
    const main = page.locator("#content");
    await expect(main.getByText("mié 07/10 10:10").first()).toBeVisible();
    await expect(main.getByText(clockCopy.now.paused)).toBeVisible();
    await expect(main.getByRole("cell", { name: "Publicación de rendición (Red de cobro Norte)", exact: true })).toBeVisible();
    await expect(main.getByRole("cell", { name: "Hito del plazo: recordatorio al operador (día hábil 5)", exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: clockCopy.upcoming.openComplaint })).toHaveAttribute("href", "/app/complaints/cmp-h000120");
    expect(await main.innerText()).not.toMatch(/SETTLEMENT_PUBLISH|OPERATOR_REMINDER|BATCH#|CMP#/);
    for (const name of [clockCopy.now.title, clockCopy.move.title, clockCopy.live.title, clockCopy.upcoming.title, clockCopy.reset.title]) await expect(page.getByRole("heading", { name })).toBeVisible();
  });

  test("[FL-082] “Avanzar al próximo evento” moves the clock and says where it went and what fired", async ({ page }) => {
    let moved = false;
    await openClock(page, (path) => {
      if (path === "clock.advanceToNext") {
        moved = true;
        return { data: MOVED };
      }
      if (path === "clock.get") return { data: clockAnswer(moved ? { simNow: MOVED.simNow, upcoming: [] } : {}) };
      return NOT_IMPLEMENTED;
    });
    const request = page.waitForRequest((candidate) => candidate.url().includes("/api/clock.advanceToNext"));
    await page.locator("#clock-move").getByRole("button", { name: clockCopy.move.next }).click();
    expect(inputOf(await request) ?? {}).toEqual({});
    await expect(page.getByText(clockCopy.move.moved("mié 07/10 10:10", "jue 08/10 08:30", 1))).toBeVisible();
    await expect(page.locator("#clock-now").getByText("jue 08/10 08:30")).toBeVisible();
  });

  test("[FL-082] a busy world disables the moves with what it waits for, and offers “Avanzar igual” once the BFF accepts it", async ({ page }) => {
    const waited = new Date(Date.now() - 6 * 60_000).toISOString();
    const busy = { reason: "EMAIL_PENDING", pending: [{ kind: "MAIL", sinceReal: waited, stale: false }], forceAllowedAtReal: new Date(Date.now() - 60_000).toISOString() };
    await openClock(page, (path) => {
      if (path === "clock.get") return { data: clockAnswer({ busy }) };
      if (path === "clock.advanceToNext") return { data: { ...MOVED, forced: true } };
      return NOT_IMPLEMENTED;
    });
    await expect(page.locator("#clock-move").getByRole("button", { name: clockCopy.move.next })).toBeDisabled();
    await expect(page.locator("#clock-live").getByRole("button", { name: clockCopy.live.live })).toBeDisabled();
    await expect(page.getByText("un email esperando su evento de entrega de SES · 1 cosa pendiente")).toBeVisible();
    expect(await page.locator("#content").innerText()).not.toContain("EMAIL_PENDING");
    const request = page.waitForRequest((candidate) => candidate.url().includes("/api/clock.advanceToNext"));
    await page.getByRole("button", { name: clockCopy.busy.force }).click();
    expect(inputOf(await request)).toEqual({ force: true });
  });

  test("[FL-082] the live clock: presets of 1 day per minute and per 5 minutes, a bounded rate, and a refusal in words", async ({ page }) => {
    let running = false;
    await openClock(page, (path) => {
      if (path === "clock.get") return { data: clockAnswer(running ? { mode: "RUNNING", rate: 288, runningUntilReal: new Date(Date.now() + 30 * 60_000).toISOString() } : {}) };
      if (path === "clock.setRunning") {
        running = true;
        return { data: { mode: "RUNNING" } };
      }
      if (path === "clock.advance") return refusal("CONFLICT", 409, "WORLD_BUSY");
      return NOT_IMPLEMENTED;
    });
    const live = page.locator("#clock-live");
    const rate = live.getByLabel(clockCopy.live.custom);
    await rate.fill("0");
    await expect(live.getByRole("button", { name: clockCopy.live.apply })).toBeDisabled();
    await expect(live.getByText(clockCopy.live.customInvalid(1, 2880))).toBeVisible();
    await rate.fill("2881");
    await expect(live.getByRole("button", { name: clockCopy.live.apply })).toBeDisabled();
    await rate.fill("288");
    await expect(live.getByText("1 día simulado cada 5 min reales")).toBeVisible();

    const slow = page.waitForRequest((candidate) => candidate.url().includes("/api/clock.setRunning"));
    await live.getByRole("button", { name: clockCopy.live.slow }).click();
    expect(inputOf(await slow)).toEqual({ rate: 288 });
    await expect(page.locator("#clock-now").getByText(clockCopy.now.running(288))).toBeVisible();
    await expect(page.locator("#clock-now").getByText(/Vuelve solo a pausa en (29|30|31) min reales\./)).toBeVisible();

    await page.locator("#clock-move").getByRole("button", { name: clockCopy.move.hour }).click();
    await expect(page.getByRole("alert").filter({ hasText: clockCopy.refusals.WORLD_BUSY ?? "" })).toBeVisible();
  });
});

test.describe("resetting a world [FL-100]", () => {
  test("[FL-100] “Reiniciar” asks for the reset, shows “Estamos reiniciando tu mundo”, polls clock.resetStatus and comes back on READY", async ({ page }) => {
    let resetting = false;
    let polls = 0;
    const calls = await openClock(page, (path) => {
      if (path === "clock.reset") {
        resetting = true;
        return { data: { status: "RESETTING", requestId: "rst-1" } };
      }
      if (path === "clock.resetStatus") {
        polls += 1;
        if (polls >= 2) resetting = false;
        return { data: { status: polls >= 2 ? "READY" : "RESETTING", phase: "WIPE" } };
      }
      if (resetting) return WORLD_RESETTING;
      if (path === "clock.get") return { data: clockAnswer({ worldEpoch: polls >= 2 ? 2 : 1 }) };
      return NOT_IMPLEMENTED;
    });
    const reset = page.locator("#clock-reset");
    await reset.getByRole("button", { name: clockCopy.reset.ask }).click();
    await expect(reset.getByText(clockCopy.reset.confirmLead)).toBeVisible();
    await reset.getByRole("button", { name: clockCopy.reset.confirm }).click();
    await expect(page.getByRole("heading", { name: copy.shell.resettingTitle })).toBeVisible();
    await expect(page.getByText(copy.shell.resettingLead)).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.views.clock.title })).toBeVisible({ timeout: 15_000 });
    expect(calls.filter((call) => call.path === "clock.reset")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "clock.resetStatus")).toHaveLength(2);
    // Back on READY the clock is read again, from the new epoch.
    const lastPoll = calls.map((call) => call.path).lastIndexOf("clock.resetStatus");
    expect(calls.slice(lastPoll + 1).some((call) => call.path === "clock.get")).toBe(true);
  });

  test("[FL-100] a second reset within 10 minutes is refused in words, and nothing else changes", async ({ page }) => {
    await openClock(page, (path) => {
      if (path === "clock.get") return { data: clockAnswer() };
      if (path === "clock.reset") return refusal("CONFLICT", 409, "RATE_LIMITED");
      return NOT_IMPLEMENTED;
    });
    await page.locator("#clock-reset").getByRole("button", { name: clockCopy.reset.ask }).click();
    await page.locator("#clock-reset").getByRole("button", { name: clockCopy.reset.confirm }).click();
    await expect(page.getByRole("alert").filter({ hasText: clockCopy.refusals.RATE_LIMITED ?? "" })).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.views.clock.title })).toBeVisible();
  });
});
