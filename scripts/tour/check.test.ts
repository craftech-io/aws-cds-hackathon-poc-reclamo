// tour:check (scripts/tour/check.ts): steps.ts is the one source of the guided tour; the README, the
// SC-21 scenario and the budgets `tour.steps` serves follow it, or the check says where they differ.
import { describe, expect, it } from "vitest";
import { TOUR_BLOCKS as SERVED_BLOCKS } from "../../packages/bff/src/routers/tour";
import { TOUR_STEPS, type TourStep, stepById } from "../../packages/web/src/views/tour/steps";
import { TOUR_END, TOUR_START, checkBudgets, checkReadme, checkScenario, readmeBlock, renderReadmeSection, validateSteps, withReadmeBlock } from "./check";

const README = `# Product\n\n## Guided tour\n\n${TOUR_START}\nold table\n${TOUR_END}\n\n## Submission notes\n`;

function withStep(id: TourStep["id"], change: (step: TourStep) => TourStep): readonly TourStep[] {
  return TOUR_STEPS.map((step) => (step.id === id ? change(step) : step));
}

describe("the steps of the guided tour", () => {
  it("are consistent: ordered, every placeholder declared in both languages, instants inside the window, blocks within budget", () => {
    expect(validateSteps()).toEqual([]);
  });

  it("report a placeholder used in one language only, an instant outside the window and a step out of order", () => {
    const broken = withStep("2", (step) => ({ ...step, look: { ...step.look, en: "Number only {number}." } }));
    expect(validateSteps(broken)).toEqual([expect.stringContaining(`2: "en" uses {number} but declares {deadline, number}`)]);
    const late = withStep("1", (step) => ({ ...step, facts: { start: { format: "time", expected: "2026-11-30T10:00:00-03:00", source: { kind: "WORLD_START" } } } }));
    expect(validateSteps(late)).toEqual([expect.stringContaining("1: {start} 2026-11-30T10:00:00-03:00 is outside the tour window")]);
    const swapped = [stepById("2"), stepById("1"), ...TOUR_STEPS.slice(2)];
    expect(validateSteps(swapped)[0]).toMatch(/^steps are 2, 1, 2b/);
  });

  it("report a challenge answer that is not the persona's and a block over its budget", () => {
    const wrong = withStep("6", (step) => ({ ...step, moves: step.moves.map((move) => (move.kind === "run" && move.action.kind === "sendText" ? { ...move, action: { ...move.action, text: "1/1" } } : move)) }));
    expect(validateSteps(wrong)).toEqual(["6: “1/1” is not C02's challenge answer"]);
    const slow = withStep("4", (step) => ({ ...step, budgetSeconds: 400 }));
    expect(validateSteps(slow)).toEqual([expect.stringMatching(/^QUICK: the steps add up to \d+ s, over the block's 300 s$/)]);
  });

  it("have the budgets tour.steps serves, and say which step differs", () => {
    expect(checkBudgets()).toEqual([]);
    const served = SERVED_BLOCKS.map((block) => (block.block === "DEEP" ? { ...block, steps: block.steps.map(([id, seconds]) => [id, id === "9" ? 240 : seconds] as const) } : block));
    expect(checkBudgets(TOUR_STEPS, served)).toEqual([expect.stringContaining("DEEP: steps.ts has 6=90, 7=120, 8=20, 9=180")]);
  });
});

describe("the README's guided tour", () => {
  it("is one English table per block with every step, its buttons, what to look at with the expected values, and its budget", () => {
    const section = renderReadmeSection();
    expect(section.startsWith("**5-minute tour**")).toBe(true);
    expect(section).toContain("**Deep tour (15 minutes)**");
    for (const step of TOUR_STEPS) expect(section).toContain(`| ${step.id} | ${step.title.en} |`);
    expect(section).toContain("Number R-2026-000123 and deadline Thu Oct 22");
    expect(section).toContain("reminder on Fri Oct 16 10:00 and escalation to the supervisor on Wed Oct 21 10:00");
    expect(section).toContain("| ~1.5 min |");
    expect(section).not.toMatch(/\{[a-z][a-zA-Z]*\}/);
  });

  it("is pending without its markers, ok when it matches and an error naming the first differing lines otherwise", () => {
    expect(checkReadme(undefined)).toMatchObject({ status: "pending" });
    expect(checkReadme("# Product\n")).toMatchObject({ status: "pending" });
    const written = withReadmeBlock(README, renderReadmeSection());
    expect(readmeBlock(written)).toBe(renderReadmeSection());
    expect(written.endsWith("## Submission notes\n")).toBe(true);
    expect(checkReadme(written)).toEqual({ status: "ok" });
    const verdict = checkReadme(README);
    expect(verdict.status).toBe("error");
    expect(verdict.status === "error" ? verdict.errors[1] : "").toContain("line 1: expected **5-minute tour** / found old table");
  });
});

describe("the SC-21 scenario", () => {
  it("is pending until it exists, and must import steps.ts and walk TOUR_STEPS or name every step", () => {
    expect(checkScenario(undefined, undefined)).toMatchObject({ status: "pending" });
    expect(checkScenario("sc-21-guest-tour.ts", `import { TOUR_STEPS } from "../../packages/web/src/views/tour/steps";\nfor (const step of TOUR_STEPS) {}`)).toEqual({ status: "ok" });
    expect(checkScenario("sc-21-guest-tour.ts", "const steps = [1, 2, 3];")).toEqual({
      status: "error",
      errors: ["sc-21-guest-tour.ts: does not import packages/web/src/views/tour/steps", expect.stringContaining("neither walks TOUR_STEPS nor names the steps 1, 2, 2b")],
    });
  });
});
