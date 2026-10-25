// FL-101 · the guest's guided tour (`/app/tour`, docs/design-brief.md §15, views/tour/steps.ts) on the
// console alone: `tour.*`, `clock.*` and `customers.get` are answered from the page with the shapes of
// the BFF. The panel checks the world is pristine before step 1 (and offers the reset otherwise, coming
// back to check again once the world is READY), counts "Tu recorrido: ~X min", sends each button
// through `tour.run`, waits for a quiet world before moving the clock and reads in Spanish or English.
// No visible text names a contest. Nothing leaves the machine.
import { type Page, type Request, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { TOUR_TEXTS } from "../src/views/tour/copy.ts";
import { MAIN_STORY, NORTE_PUBLISH, TOUR_START_SIM, TOUR_STEPS, stepById } from "../src/views/tour/steps.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, WORLD_RESETTING, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

const GUEST = { username: "guest-03", role: "GUEST", worldId: "g03" } as const;
const es = TOUR_TEXTS.es;

function tourSteps(overrides: Record<string, unknown> = {}) {
  return {
    totalMinutes: 5,
    steps: TOUR_STEPS.map((step) => ({ id: step.id, title: step.id, block: step.block, minutes: step.budgetSeconds / 60 })),
    worldId: "g03",
    simNow: TOUR_START_SIM,
    mode: "PAUSED",
    startAtSim: TOUR_START_SIM,
    pristine: { ok: true, clockAtStart: true, mainStoryFiled: false },
    mainStory: null,
    nextEvents: [{ kind: "SETTLEMENT_PUBLISH", timerId: "NORTE-2026-10-07", dueAtSim: NORTE_PUBLISH.dueAtSim, ownerKey: NORTE_PUBLISH.ownerKey }],
    measured: false,
    ...overrides,
  };
}

function clock(overrides: Record<string, unknown> = {}) {
  return { worldId: "g03", worldEpoch: 1, mode: "PAUSED", simNow: TOUR_START_SIM, upcoming: [], busy: null, ...overrides };
}

function inputOf(request: Request): unknown {
  const body = request.postDataJSON() as Record<string, unknown> | null;
  return body?.["0"];
}

const panel = (page: Page) => page.locator("#content");
const card = (page: Page, id: string) => page.getByRole("article", { name: new RegExp(`^${es.step(id)} · `) });

async function openTour(page: Page, script: (path: string) => ApiAnswer | undefined) {
  const calls = await routeApi(page, (path) => script(path) ?? NOT_IMPLEMENTED);
  await plantSession(page, GUEST);
  await page.goto("/app/tour");
  await expect(page.getByRole("heading", { name: copy.views.tour.title })).toBeVisible();
  return calls;
}

test.describe("the guided tour [FL-101]", () => {
  test("[FL-101] checks the world is pristine, says “Tu recorrido: ~5 min” and lists both blocks with every step", async ({ page }) => {
    await openTour(page, (path) => (path === "tour.steps" ? { data: tourSteps() } : path === "clock.get" ? { data: clock() } : undefined));
    await expect(panel(page).getByText(es.pristineOk("mié 07/10 10:10"))).toBeVisible();
    await expect(panel(page).getByRole("status").filter({ hasText: es.yourTour(5) })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recorrido de 5 minutos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recorrido profundo de 15 minutos" })).toBeVisible();
    for (const step of TOUR_STEPS) await expect(card(page, step.id)).toBeVisible();
    await expect(card(page, "2")).toContainText(`Número ${MAIN_STORY.number} y plazo jue 22/10`);
    await expect(card(page, "3")).toContainText("la red rinde el jue 08/10 08:30");
    const text = await panel(page).innerText();
    expect(text).not.toMatch(/hackat|devpost|concurso|premio|jurado|juez|jueces|judge|evaluaci/i);
  });

  test("[FL-101] reads in English with its switch, remembered for the next visit", async ({ page }) => {
    await openTour(page, (path) => (path === "tour.steps" ? { data: tourSteps() } : path === "clock.get" ? { data: clock() } : undefined));
    await page.getByRole("group", { name: es.langLabel }).getByRole("button", { name: "EN" }).click();
    await expect(panel(page).getByRole("status").filter({ hasText: TOUR_TEXTS.en.yourTour(5) })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deep tour (15 minutes)" })).toBeVisible();
    await expect(panel(page).getByText("Number R-2026-000123 and deadline Thu Oct 22", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "5-minute tour" })).toBeVisible();
  });

  test("[FL-101] each button goes through tour.run; the main story's number and deadline then come from the world", async ({ page }) => {
    let filed = false;
    const calls = await openTour(page, (path) => {
      if (path === "tour.run") {
        filed = true;
        return { data: { kind: "sendScript", sent: [] } };
      }
      if (path === "tour.steps") return { data: tourSteps(filed ? { mainStory: { complaintId: "cmp-l000001", complaintNumber: "R-2026-000777", status: "REGISTERED", deadlineSim: "2026-10-23T23:59:59-03:00" }, pristine: { ok: false, clockAtStart: true, mainStoryFiled: true } } : {}) };
      if (path === "clock.get") return { data: clock() };
      return undefined;
    });
    await card(page, "1").getByRole("button", { name: es.markDone }).click();
    const run = page.waitForRequest((request) => request.url().includes("/api/tour.run"));
    await card(page, "2").getByRole("button", { name: stepById("2").moves[0]?.label.es ?? "" }).click();
    expect(inputOf(await run)).toEqual({ action: { kind: "sendScript", persona: "C01" } });
    await expect(card(page, "2")).toContainText("Número R-2026-000777 y plazo vie 23/10");
    await expect(card(page, "2").getByRole("button", { name: new RegExp(es.moveDone) })).toBeVisible();
    expect(calls.filter((call) => call.path === "tour.steps").length).toBeGreaterThan(1);
  });

  test("[FL-101] a clock move waits for a quiet world, and a persona's milestone uses that persona's complaint", async ({ page }) => {
    let busy = true;
    await openTour(page, (path) => {
      if (path === "tour.steps") return { data: tourSteps() };
      if (path === "clock.get") return { data: clock({ busy: busy ? { reason: "EVENT_IN_FLIGHT", pending: [], forceAllowedAtReal: new Date(Date.now() + 300_000).toISOString() } : null }) };
      if (path === "customers.get") return { data: { complaints: [{ complaintId: "cmp-h000040", complaintNumber: "R-2026-000040", open: false }, { complaintId: "cmp-l000084", complaintNumber: "R-2026-000126", open: true }] } };
      if (path === "tour.run") return { data: { kind: "advanceToNext", moved: {} } };
      return undefined;
    });
    for (const id of ["1", "2", "2b", "3"]) await card(page, id).getByRole("button", { name: es.markDone }).click();
    const advance = card(page, "4").getByRole("button", { name: stepById("4").moves[0]?.label.es ?? "" });
    await expect(advance).toBeDisabled();
    await expect(card(page, "4")).toContainText(es.busy("un turno del agente o un evento en cola"));
    busy = false;
    await expect(advance).toBeEnabled({ timeout: 10_000 });

    for (const id of ["4", "5", "6", "7", "8"]) await card(page, id).getByRole("button", { name: es.markDone }).click();
    const step9 = stepById("9");
    for (const index of [0, 1, 2]) await card(page, "9").getByRole("button", { name: step9.moves[index]?.label.es ?? "" }).click();
    const milestone = page.waitForRequest((request) => request.url().includes("/api/tour.run") && (request.postData() ?? "").includes("advanceToNext"));
    await card(page, "9").getByRole("button", { name: step9.moves[3]?.label.es ?? "" }).click();
    expect(inputOf(await milestone)).toEqual({ action: { kind: "advanceToNext", complaintNumber: "R-2026-000126" } });
    await card(page, "9").getByRole("button", { name: step9.moves[5]?.label.es ?? "" }).click();
    await page.waitForURL("**/app/complaints/cmp-l000084");
  });

  test("[FL-101] a world that is not pristine offers the reset; the tour waits for READY and checks the world again", async ({ page }) => {
    let resetting = false;
    let polls = 0;
    const calls = await openTour(page, (path) => {
      if (path === "clock.reset") {
        resetting = true;
        return { data: { status: "RESETTING", requestId: "rst-1" } };
      }
      if (path === "clock.resetStatus") {
        polls += 1;
        if (polls >= 2) resetting = false;
        return { data: { status: polls >= 2 ? "READY" : "RESETTING", phase: "RELOAD" } };
      }
      if (resetting) return WORLD_RESETTING;
      if (path === "tour.steps") return { data: polls >= 2 ? tourSteps() : tourSteps({ simNow: "2026-10-08T08:30:00-03:00", pristine: { ok: false, clockAtStart: false, mainStoryFiled: true }, mainStory: { complaintId: "cmp-l000001", complaintNumber: MAIN_STORY.number, status: "ANSWERED", deadlineSim: MAIN_STORY.deadlineSim } }) };
      if (path === "clock.get") return { data: clock({ worldEpoch: polls >= 2 ? 2 : 1 }) };
      return undefined;
    });
    const warning = page.getByRole("alert").filter({ hasText: es.pristineTitle });
    await expect(warning).toContainText(es.pristineClock("jue 08/10 08:30"));
    await expect(warning).toContainText(es.pristineFiled(MAIN_STORY.number));
    await warning.getByRole("button", { name: es.resetAsk }).click();
    await warning.getByRole("button", { name: es.resetConfirm }).click();
    await expect(page.getByRole("heading", { name: copy.shell.resettingTitle })).toBeVisible();
    await expect(page.getByText(es.pristineOk("mié 07/10 10:10"))).toBeVisible({ timeout: 15_000 });
    expect(calls.filter((call) => call.path === "clock.reset")).toHaveLength(1);
    const lastPoll = calls.map((call) => call.path).lastIndexOf("clock.resetStatus");
    expect(calls.slice(lastPoll + 1).some((call) => call.path === "tour.steps")).toBe(true);
  });
});
