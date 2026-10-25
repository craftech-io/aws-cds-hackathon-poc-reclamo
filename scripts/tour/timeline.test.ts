// The replay of the guided tour (scripts/tour/timeline.ts, docs/seed-spec.md §14 invariants 18 to 22):
// steps.ts walked over a local world of the `guest` template with the scripted Harness reaches every
// state and hour the tour promises; a world that does not is reported step by step.
import { describe, expect, it, vi } from "vitest";
import type { ScriptedTurn } from "../../tests/flows/support/scripted-harness";
import { HUMAN_CASE, NORTE_PUBLISH, TOUR_START_SIM, type TourAction, stepById } from "../../packages/web/src/views/tour/steps";
import { tourAutopilot } from "./autopilot";
import { createLfTourWorld } from "./lf-world";
import { GUEST_TASKS, REPLAYED_STEPS, type TourLanding, type TourWorld, inFormalNoticeHours, walkTour } from "./timeline";

// A whole guest world (some 20,000 items) and about thirty turns: generous on a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

describe("the replay of the guided tour over the guest template", () => {
  it("reaches every promised state: number, blocked collection, reading, settlement, reversal, approval, human case and register", async () => {
    const world = await createLfTourWorld();
    const report = await walkTour(world);
    expect(report.problems).toEqual([]);

    const byStep = new Map(report.steps.map((step) => [step.id, step]));
    // 20: the collection attempt happens on Wed 07/10 10:1x, inside the formal notice's hours.
    expect(byStep.get("2b")?.simNow).toBe(TOUR_START_SIM);
    // 21: ONE advance from step 3 publishes the batch and matches the main story.
    expect(byStep.get("4")?.landings.map((landing) => landing.simNow)).toEqual([NORTE_PUBLISH.dueAtSim]);
    // 22: the milestones of the human case land on the hours step 9 names.
    expect(byStep.get("9")?.landings.map((landing) => landing.simNow)).toEqual([HUMAN_CASE.reminderSim, HUMAN_CASE.escalationSim]);
    // 19: the tour ends on Wed 21/10 10:00 and no seeded complaint is overdue.
    expect((await world.clock()).simNow).toBe(HUMAN_CASE.escalationSim);
    expect((await world.seededComplaints()).filter((complaint) => complaint.slaState === "OVERDUE")).toEqual([]);
  });
});

/** A world that keeps no promise: the clock never moves and nothing is filed. */
function idleWorld(overrides: Partial<TourWorld> = {}): TourWorld {
  return {
    run: async (action: TourAction): Promise<TourLanding | undefined> => (action.kind === "advanceToNext" ? { simNow: TOUR_START_SIM, fired: [] } : undefined),
    task: async () => undefined,
    clock: async () => ({ simNow: TOUR_START_SIM, mode: "PAUSED" }),
    pristine: async () => true,
    complaint: async () => undefined,
    milestones: async () => [],
    outbound: async () => [],
    emails: async () => [],
    evidence: async () => [],
    actions: async () => [],
    approvals: async () => [],
    newTape: async () => [],
    seededComplaints: async () => [{ number: "R-2026-000120", slaState: "OVERDUE" }],
    measured: async () => 0,
    lastExport: () => undefined,
    deadLetters: () => ["TIMER (ZodError)"],
    ...overrides,
  };
}

describe("the replay's report", () => {
  it("names, step by step, every promise a world does not keep, and what went wrong outside them", async () => {
    const report = await walkTour(idleWorld());
    expect(report.steps.find((step) => step.id === "1")?.problems).toEqual([]);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        "2: the main story's number is missing, not R-2026-000123",
        "2b: no BLOCKED collection reminder by WhatsApp with CH-WA-NO-COLLECTION on the tape",
        `4: one advance lands at ${TOUR_START_SIM}, not ${NORTE_PUBLISH.dueAtSim}`,
        "4: the main story did not reach MATCHED in the same advance",
        "7: the refund was not executed exactly once",
        "10: the register export says nothing, not ok",
        "seeded complaints turned OVERDUE during the tour: R-2026-000120",
        `the tour ends at ${TOUR_START_SIM}, not at ${HUMAN_CASE.escalationSim}`,
      ]),
    );
    expect(report.warnings).toEqual(["1 event(s) dead-lettered during the replay: TIMER (ZodError)"]);
  });

  it("[FL-017] holds step 3 to what the landing says: the model's reading confirmed by the fallback, never the fallback alone", async () => {
    const reading = (source: string) => idleWorld({ evidence: async () => [{ kind: "RECEIPT_READING", result: "READ", source }] });
    const problems = async (world: TourWorld) => (await walkTour(world, [stepById("3")])).steps[0]?.problems ?? [];
    expect(await problems(reading("FALLBACK"))).toContain("3: the receipt reading is FALLBACK, not the model's reading confirmed by the fallback (BOTH_AGREE)");
    expect((await problems(reading("BOTH_AGREE"))).filter((problem) => problem.includes("receipt reading"))).toEqual([]);
  });

  it("reports a move that fails with the step and the button, and goes on with the next step", async () => {
    const report = await walkTour(
      idleWorld({
        run: async (action) => {
          if (action.kind === "sendScript") throw new Error("WORLD_BUSY");
          return undefined;
        },
      }),
      [stepById("2"), stepById("5")],
    );
    expect(report.steps.map((step) => step.id)).toEqual(["2", "5"]);
    expect(report.steps[0]?.problems[0]).toBe("2: “Send the script message and receipt (Valeria)” failed: WORLD_BUSY");
  });

  it("walks every step but the optional live clock, with a guest task behind every view where the step happens", () => {
    expect(REPLAYED_STEPS.map((step) => step.id)).toEqual(["1", "2", "2b", "3", "4", "5", "6", "7", "8", "9", "10", "12"]);
    for (const key of Object.keys(GUEST_TASKS)) {
      const [id, view] = key.split(":");
      expect(stepById(id as never).moves.some((move) => move.kind === "open" && move.target.view === view), key).toBe(true);
    }
  });

  it("knows the formal notice's hours: Monday to Friday, 09:00 to 18:00 in Argentina", () => {
    expect(inFormalNoticeHours("2026-10-07T10:10:00-03:00")).toBe(true);
    expect(inFormalNoticeHours("2026-10-07T08:59:00-03:00")).toBe(false);
    expect(inFormalNoticeHours("2026-10-10T10:00:00-03:00")).toBe(false);
  });
});

describe("the replay's autopilot", () => {
  const turn = (type: string, inbound: string | undefined, identified: boolean): ScriptedTurn =>
    ({
      index: 1,
      request: {} as ScriptedTurn["request"],
      sessionToken: "st",
      event: { type, id: "e", at: TOUR_START_SIM },
      facts: [{ name: "complaint", attributes: { number: "R-2026-000124", type: "UNRECOGNIZED_CHARGE" } }],
      ...(inbound === undefined ? {} : { inbound }),
      attachments: [],
      preloaded: { identify_customer: identified ? { status: "IDENTIFIED" } : { status: "NEEDS_CHALLENGE", challenge: { promptText: "Para ver tu cuenta, decime la fecha." } } },
    }) as ScriptedTurn;

  it("asks the challenge the code chose, verifies the customer's answer and never writes an amount, a cap or a decision", async () => {
    const plans = tourAutopilot(() => []);
    expect(await plans(turn("CUSTOMER_MESSAGE", "Me cobraron de más", false))).toEqual([{ tool: "send_whatsapp", input: { kind: "IDENTITY_CHALLENGE", text: "Para ver tu cuenta, decime la fecha." } }]);
    const answer = await plans(turn("CUSTOMER_MESSAGE", "10/9", false));
    const calls = "calls" in answer ? answer.calls : answer;
    expect(calls.map((call) => call.tool)).toEqual(["verify_challenge", "list_operations", "check_charge", "reverse_charge", "update_complaint", "send_whatsapp"]);
    expect(JSON.stringify(calls)).not.toMatch(/amount|capOverride|decision/);
    expect(await plans(turn("OPERATOR_RELEASED", undefined, true))).toEqual([]);
  });
});
