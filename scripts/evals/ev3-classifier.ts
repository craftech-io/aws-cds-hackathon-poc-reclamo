// EV-3 · intake classifier (docs/test-plan.md §6, docs/seed-spec.md §12, ADR-0016): the 120 messages
// of `evals/classifier.json`, each the first message of its own customer, through `wa.inbound` into QA
// worlds created with `settings.intakeOnly = true` (the worker records the classification and never
// invokes the Harness). The eval reads:
//
//   snapshot        whether the message registered a complaint, and of which type (what the code decided)
//   intake.inspect  the `INTAKE_CLASSIFIED` decision: kind, type, source (rule, model, fallback) and the
//                   latency of the model path (qa-driver/actions-turns.ts)
//
// A world whose first message still produces an agent turn has no `intakeOnly`: the eval stops there
// instead of spending 120 turns, and the rest of the set is BLOCKED.
import { z } from "zod";
import type { ModelsDocument } from "../../packages/bff/src/qa-driver/world-models";
import { eligibleModels, spreadOverWorlds } from "./challenge";
import type { ClassifierEntry, ClassifierSet } from "./datasets";
import { DriverRefusal, type EvalDriver } from "./driver";
import { createWorld, destroyWorld, type EvalPersona, type EvalWorld, sendText, settle, snapshotOf } from "./worlds";

export const EV3_PER_WORLD = 12;
/** Outbound kinds only an agent turn produces: with `intakeOnly` none of them may appear. */
const AGENT_KINDS = new Set(["REPLY", "IDENTITY_CHALLENGE", "RECEIPT_REQUEST", "FORMAL_ANSWER", "SAFETY_GUIDANCE"]);

/** What the driver's `intake.inspect({worldId, customerId})` answers, oldest first. */
export const IntakeInspection = z.object({
  classifications: z.array(
    z.object({
      kind: z.string(),
      type: z.string().optional(),
      source: z.enum(["RULE", "MODEL", "FALLBACK"]),
      confidence: z.number().min(0).max(1),
      modelMs: z.number().nonnegative().optional(),
      fallback: z.string().optional(),
    }),
  ),
});

export type Classified = { readonly kind: "READ"; readonly decided: string; readonly type?: string; readonly source: "RULE" | "MODEL" | "FALLBACK"; readonly modelMs?: number } | { readonly kind: "BLOCKED"; readonly reason: string };

export interface ClassifierObservation {
  readonly id: string;
  readonly expectedKind: ClassifierEntry["expected"]["kind"];
  readonly expectedType?: string;
  /** A complaint the message registered (new in the conversation), with its type. */
  readonly registered: boolean;
  readonly registeredType?: string;
  /** An agent turn ran: the world did not honour `intakeOnly`. */
  readonly agentTurned: boolean;
  readonly settled: boolean;
  readonly classified: Classified;
  readonly error?: string;
}

async function classified(driver: EvalDriver, world: EvalWorld, persona: EvalPersona, step: number): Promise<Classified> {
  try {
    const raw = IntakeInspection.parse(await driver.call("intake.inspect", { worldId: world.worldId, customerId: persona.customerId }, { scenario: world.scenario, step, label: "intake" }));
    const last = raw.classifications[raw.classifications.length - 1];
    if (last === undefined) return { kind: "BLOCKED", reason: "no INTAKE_CLASSIFIED decision for the message" };
    return { kind: "READ", decided: last.kind, source: last.source, ...(last.type === undefined ? {} : { type: last.type }), ...(last.modelMs === undefined ? {} : { modelMs: last.modelMs }) };
  } catch (error) {
    if (error instanceof DriverRefusal && error.blocked) return { kind: "BLOCKED", reason: error.message };
    throw error;
  }
}

async function classifyOne(driver: EvalDriver, world: EvalWorld, persona: EvalPersona, entry: ClassifierEntry, step: number): Promise<ClassifierObservation> {
  const before = await snapshotOf(driver, world, persona, step, "before");
  const known = new Set(before.complaints.flatMap((view) => (view.complaint === null ? [] : [view.complaint.complaintId])));
  await sendText(driver, world, persona, entry.text, step, "message");
  const settled = await settle(driver, world, persona, step);
  const after = await snapshotOf(driver, world, persona, step, "after");
  const fresh = after.complaints.flatMap((view) => (view.complaint === null || known.has(view.complaint.complaintId) ? [] : [view.complaint]));
  return {
    id: entry.id,
    expectedKind: entry.expected.kind,
    ...(entry.expected.type === undefined ? {} : { expectedType: entry.expected.type }),
    registered: fresh.length > 0,
    ...(fresh[0] === undefined ? {} : { registeredType: fresh[0].type }),
    agentTurned: after.messages.some((message) => message.direction === "OUT" && message.kind !== null && AGENT_KINDS.has(message.kind)),
    settled,
    classified: await classified(driver, world, persona, step),
  };
}

function notRun(entry: ClassifierEntry, reason: string): ClassifierObservation {
  return {
    id: entry.id,
    expectedKind: entry.expected.kind,
    ...(entry.expected.type === undefined ? {} : { expectedType: entry.expected.type }),
    registered: false,
    agentTurned: false,
    settled: false,
    classified: { kind: "BLOCKED", reason },
    error: reason,
  };
}

export interface Ev3Options {
  readonly set: ClassifierSet;
  readonly models: ModelsDocument;
  readonly withinBudget: () => boolean;
}

export async function runEv3(driver: EvalDriver, options: Ev3Options): Promise<ClassifierObservation[]> {
  const entries = options.set.entries;
  const plan = spreadOverWorlds(eligibleModels(options.models), entries.length, EV3_PER_WORLD);
  const observations: ClassifierObservation[] = [];
  let stopped: string | undefined;
  for (const [index, models] of plan.entries()) {
    const slice = entries.slice(index * EV3_PER_WORLD, (index + 1) * EV3_PER_WORLD);
    if (stopped !== undefined) {
      observations.push(...slice.map((entry) => notRun(entry, stopped ?? "")));
      continue;
    }
    const world = await createWorld(driver, `ev3-w${String(index + 1).padStart(2, "0")}`, models, { intakeOnly: true });
    try {
      for (const [slot, persona] of world.personas.entries()) {
        const entry = slice[slot];
        if (entry === undefined) continue;
        if (stopped !== undefined || !options.withinBudget()) {
          stopped ??= "BUDGET: the run's turn budget is spent";
          observations.push(notRun(entry, stopped));
          continue;
        }
        try {
          const observation = await classifyOne(driver, world, persona, entry, slot + 2);
          observations.push(observation);
          if (observation.agentTurned) stopped = "INTAKE_ONLY_NOT_HONOURED: an agent turn ran in an intakeOnly world";
        } catch (error) {
          observations.push(notRun(entry, error instanceof Error ? error.message : String(error)));
        }
      }
    } finally {
      await destroyWorld(driver, world);
    }
  }
  return observations;
}
