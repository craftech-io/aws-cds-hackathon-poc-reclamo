// QA worlds of the evaluations (docs/test-plan.md §4.2, §4.4): created from the `models` template with
// the clock paused, one conversation per customer, settled before anything is read, destroyed in
// `finally`. Every wait is a non-blocking probe repeated with `eventually()`; the topes are the ones of
// §4.3 (world 600 s, turn and quiet world 300 s in total).
//
// A world is `qa-<runId>-<scenario>` (`ev1-w1`, `ev2`, `ev2-path`, `ev3-w01`): the key of `world.create`
// carries the same run and the same `evN` prefix, as the driver's guard requires.
import { z } from "zod";
import { scenarioWorldId } from "../../packages/bff/src/qa-driver/guard";
import type { WorldSettingsOverride } from "../../packages/bff/src/qa-driver/inputs";
import { cloneCustomerId } from "../../packages/bff/src/qa-driver/world-models";
import type { ModelsDocument } from "../../packages/bff/src/qa-driver/world-models";
import { challengeAnswer } from "./challenge";
import { type EvalDriver, eventually } from "./driver";

export const WORLD_CREATE_TIMEOUT_MS = 600_000;
export const WORLD_DESTROY_TIMEOUT_MS = 300_000;
export const QUIET_TIMEOUT_MS = 300_000;
const QUIET_EVERY_MS = 10_000;
const CREATE_EVERY_MS = 10_000;

export interface EvalPersona {
  /** Clone key in the world (`p01`…). */
  readonly key: string;
  /** The model persona it is cloned from (`C02`). */
  readonly model: string;
  readonly customerId: string;
}

export interface EvalWorld {
  readonly scenario: string;
  readonly worldId: string;
  readonly personas: readonly EvalPersona[];
}

const Probe = z.looseObject({ state: z.string() });
const Settle = z.looseObject({ settled: z.boolean() });

export const SnapshotMessage = z.looseObject({
  messageId: z.string(),
  direction: z.enum(["IN", "OUT"]),
  kind: z.string().nullable(),
  status: z.string(),
  body: z.string(),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;

export const SnapshotComplaint = z.looseObject({
  complaint: z.looseObject({ complaintId: z.string(), type: z.string(), status: z.string() }).nullable(),
  evidence: z.array(z.looseObject({ evidenceId: z.string(), kind: z.string() })),
  actions: z.array(z.looseObject({ kind: z.string(), status: z.string().optional(), amountCents: z.number().optional() })),
});
export type SnapshotComplaint = z.infer<typeof SnapshotComplaint>;

export const Snapshot = z.looseObject({
  messages: z.array(SnapshotMessage),
  complaints: z.array(SnapshotComplaint),
  turnsToday: z.number().nonnegative().optional(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export function personaKey(index: number): string {
  return `p${String(index + 1).padStart(2, "0")}`;
}

/** Creates the world and polls the factory until `READY` (interim answers are never replayed). */
export async function createWorld(driver: EvalDriver, scenario: string, models: readonly string[], settings?: WorldSettingsOverride): Promise<EvalWorld> {
  const worldId = scenarioWorldId(driver.runId, scenario);
  const personas = models.map((model, index) => ({ key: personaKey(index), model }));
  const input = { runId: driver.runId, scenario, template: "models", personas, ...(settings === undefined ? {} : { settings }) };
  const created = await eventually(
    async () => Probe.parse(await driver.call("world.create", input, { scenario, step: 1, label: "create" })),
    (answer) => answer.state === "READY",
    { timeoutMs: WORLD_CREATE_TIMEOUT_MS, everyMs: CREATE_EVERY_MS },
  );
  if (!created.met) throw new Error(`${scenario}: the world did not reach READY in ${WORLD_CREATE_TIMEOUT_MS / 1_000} s`);
  return { scenario, worldId, personas: personas.map((persona) => ({ ...persona, customerId: cloneCustomerId(worldId, persona.key) })) };
}

/** Best effort: `WorldJanitor` sweeps a QA world older than 6 h whatever happens here. */
export async function destroyWorld(driver: EvalDriver, world: EvalWorld): Promise<boolean> {
  try {
    const destroyed = await eventually(
      async () => Probe.parse(await driver.call("world.destroy", { worldId: world.worldId }, { scenario: world.scenario, step: 999, label: "destroy" })),
      (answer) => answer.state === "DESTROYED",
      { timeoutMs: WORLD_DESTROY_TIMEOUT_MS, everyMs: CREATE_EVERY_MS },
    );
    return destroyed.met;
  } catch {
    // Never masks the eval's own outcome: the janitor's 6-hour pass removes what is left.
    return false;
  }
}

/** Quiet: two `settled` probes in a row, 10 s apart (docs/test-plan.md §4.3). */
export async function settle(driver: EvalDriver, world: EvalWorld, persona: EvalPersona, step: number): Promise<boolean> {
  let streak = 0;
  let probe = 0;
  const quiet = await eventually(
    async () => {
      probe += 1;
      const answer = Settle.parse(await driver.call("conv.settleProbe", { worldId: world.worldId, customerId: persona.customerId }, { scenario: world.scenario, step, label: `settle${probe}` }));
      streak = answer.settled ? streak + 1 : 0;
      return streak;
    },
    (count) => count >= 2,
    { timeoutMs: QUIET_TIMEOUT_MS, everyMs: QUIET_EVERY_MS },
  );
  return quiet.met;
}

export async function snapshotOf(driver: EvalDriver, world: EvalWorld, persona: EvalPersona, step: number, label: string): Promise<Snapshot> {
  return Snapshot.parse(await driver.call("snapshot", { worldId: world.worldId, customerId: persona.customerId }, { scenario: world.scenario, step, label }));
}

export async function sendText(driver: EvalDriver, world: EvalWorld, persona: EvalPersona, text: string, step: number, label: string): Promise<void> {
  await driver.call("wa.inbound", { worldId: world.worldId, persona: persona.key, content: { type: "text", text } }, { scenario: world.scenario, step, label });
}

/** True when the last outbound message asks the challenge and the customer has not answered it yet. */
export function challengePending(messages: readonly SnapshotMessage[]): boolean {
  const lastChallenge = messages.findLastIndex((message) => message.direction === "OUT" && message.kind === "IDENTITY_CHALLENGE");
  if (lastChallenge < 0) return false;
  return !messages.slice(lastChallenge + 1).some((message) => message.direction === "IN");
}

/**
 * The autopilot's one move on identity (docs/test-plan.md §4.3): a pending challenge is answered with
 * the persona's truth, then the conversation settles again. Returns whether it answered.
 */
export async function answerChallenge(driver: EvalDriver, models: ModelsDocument, world: EvalWorld, persona: EvalPersona, step: number, attempt = 1): Promise<boolean> {
  const snapshot = await snapshotOf(driver, world, persona, step, `challenge${attempt}`);
  if (!challengePending(snapshot.messages)) return false;
  const answer = challengeAnswer(models, persona.model);
  if (answer === undefined) return false;
  await sendText(driver, world, persona, answer, step, `answer${attempt}`);
  await settle(driver, world, persona, step);
  return true;
}
