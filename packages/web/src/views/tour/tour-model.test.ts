// The guided tour's state (docs/design-brief.md §15): the progress per world and epoch, the current step,
// "Tu recorrido: ~X min", the facts of "Qué mirar" read from the world and where an `open` move goes.
import { describe, expect, it } from "vitest";
import { MAIN_STORY, NORTE_PUBLISH, TOUR_START_SIM, TOUR_STEPS, formatBudget, formatTourInstant, lookText, stepById } from "./steps";
import type { TourStepsAnswer } from "./tour-api";
import { latestComplaint } from "./tour-api";
import { currentStep, factValues, loadProgress, progressKey, remainingMinutes, remainingSeconds, saveProgress, stepComplete, targetPath, withMove, withStepDone } from "./tour-model";

const WORLD: TourStepsAnswer = {
  worldId: "g03",
  simNow: "2026-10-07T10:12:00-03:00",
  mode: "PAUSED",
  startAtSim: TOUR_START_SIM,
  pristine: { ok: false, clockAtStart: false, mainStoryFiled: true },
  mainStory: { complaintId: "cmp-l000001", complaintNumber: MAIN_STORY.number, status: "REGISTERED", deadlineSim: MAIN_STORY.deadlineSim },
  nextEvents: [{ kind: "SETTLEMENT_PUBLISH", dueAtSim: NORTE_PUBLISH.dueAtSim, ownerKey: NORTE_PUBLISH.ownerKey }],
};

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) } as Storage;
}

describe("the tour's progress", () => {
  it("starts at step 1, moves on when every button of a step was taken or it was marked done, and ends", () => {
    expect(currentStep(TOUR_STEPS, new Set())?.id).toBe("1");
    let progress = withMove(new Set(), stepById("1"), 0);
    expect(currentStep(TOUR_STEPS, progress)?.id).toBe("2");
    progress = withMove(progress, stepById("2"), 0);
    expect(stepComplete(stepById("2"), progress)).toBe(false);
    progress = withStepDone(progress, stepById("2"));
    expect(currentStep(TOUR_STEPS, progress)?.id).toBe("2b");
    const all = TOUR_STEPS.reduce((acc, step) => withStepDone(acc, step), progress);
    expect(currentStep(TOUR_STEPS, all)).toBeUndefined();
  });

  it("is kept per world and epoch, and survives blocked or corrupt storage", () => {
    const storage = memoryStorage();
    const key = progressKey("g03", 2);
    expect(key).toBe("reclamo.tour.g03.e2");
    saveProgress(storage, key, withMove(new Set(), stepById("1"), 0));
    expect([...loadProgress(storage, key)]).toEqual(["1#0"]);
    expect(loadProgress(storage, progressKey("g03", 3)).size).toBe(0);
    storage.setItem(key, "{not json");
    expect(loadProgress(storage, key).size).toBe(0);
    const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
    expect(loadProgress(blocked, key).size).toBe(0);
    expect(() => saveProgress(blocked, key, new Set(["1#0"]))).not.toThrow();
  });

  it("says “Tu recorrido: ~X min” from the budgets left in the current block", () => {
    const fresh = remainingSeconds(TOUR_STEPS, new Set());
    expect(fresh).toEqual({ block: "QUICK", seconds: 10 + 10 + 30 + 90 + 90 + 20 });
    expect(remainingMinutes(fresh.seconds)).toBe(5);
    const quickDone = TOUR_STEPS.filter((step) => step.block === "QUICK").reduce((acc, step) => withStepDone(acc, step), new Set<string>() as ReadonlySet<string>);
    expect(remainingSeconds(TOUR_STEPS, quickDone).block).toBe("DEEP");
    expect(remainingMinutes(remainingSeconds(TOUR_STEPS, quickDone).seconds)).toBe(9);
    expect(remainingMinutes(5)).toBe(1);
    expect(remainingMinutes(0)).toBe(0);
  });
});

describe("“Qué mirar”", () => {
  it("is filled with the world's own number, deadline and settlement hour, in Spanish or English", () => {
    const step2 = stepById("2");
    expect(lookText(step2, "es", factValues(step2, WORLD))).toContain(`Número ${MAIN_STORY.number} y plazo jue 22/10`);
    const step3 = stepById("3");
    expect(lookText(step3, "en", factValues(step3, WORLD))).toContain("the network settles on Thu Oct 8 08:30");
    const step2b = stepById("2b");
    expect(lookText(step2b, "es", factValues(step2b, WORLD))).toContain("con el reloj en mié 07/10 10:12");
  });

  it("keeps the expected values while the world does not say (before the complaint is filed, or a computed date)", () => {
    const step2 = stepById("2");
    expect(lookText(step2, "es", factValues(step2, { ...WORLD, mainStory: null }))).toContain(`Número ${MAIN_STORY.number} y plazo jue 22/10`);
    const step9 = stepById("9");
    expect(lookText(step9, "es", factValues(step9, WORLD))).toContain("recordatorio del vie 16/10 10:00 y escalamiento al supervisor del mié 21/10 10:00");
    expect(formatTourInstant("2026-10-23T23:59:59-03:00", "en", "day")).toBe("Fri Oct 23");
    expect(formatBudget(90, "es")).toBe("~1,5 min");
    expect(formatBudget(10, "en")).toBe("~10 s");
  });
});

describe("where a button takes the guest", () => {
  it("opens the views, the persona's file and the persona's complaint once its id is known", () => {
    expect(targetPath({ view: "emails" })).toBe("/app/emails");
    expect(targetPath({ view: "customer", persona: "C09" })).toBe("/app/customers/cus-0009");
    expect(targetPath({ view: "complaint", persona: "C07" })).toBeUndefined();
    expect(targetPath({ view: "complaint", persona: "C07" }, "cmp-l000084")).toBe("/app/complaints/cmp-l000084");
  });

  it("resolves a persona's complaint to the latest open one of its file", () => {
    const file = { complaints: [{ complaintId: "cmp-h000012", complaintNumber: "R-2026-000012", open: false }, { complaintId: "cmp-l000084", complaintNumber: "R-2026-000126", open: true }] };
    expect(latestComplaint(file)).toEqual({ complaintId: "cmp-l000084", complaintNumber: "R-2026-000126" });
    expect(latestComplaint({ complaints: [] })).toBeUndefined();
    expect(latestComplaint("nonsense")).toBeUndefined();
  });
});
