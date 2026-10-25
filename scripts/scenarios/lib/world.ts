// Worlds of a scenario and the moves every scenario repeats (docs/test-plan.md §4.2, §4.4):
//
//   createWorld     `world.create` (idempotent by run and scenario) polled with ONE key until `READY`,
//                   registered for the cleanup; the models template starts PAUSED on Wed 07/10 10:10
//   advance*        always the world quiet first (`conv.settleProbe` settled twice), then the frozen clock
//                   moves: to the next timer, to an instant, by minutes; the simulated time never drifts
//   schedulerProbe  the only real wait for the Scheduler: `clock.unfreeze({timerKey, leadSec: 120})`, the
//                   real schedule fires it within 240 s (`firedBy SCHEDULER`), `clock.freeze` in `finally`
//   cleanupWorlds   per world, `policyAudit.run` (kept for the report and SC-20) and `world.destroy`
import type { HistoryEntry, WorldSettingsOverride } from "@reclamo/bff/qa-driver/inputs";
import { timelineOf, itemsOf } from "./console";
import { WAITS } from "./eventually";
import { type ScenarioContext, ensure } from "./steps";
import { complaintOwner, timerKeyOf } from "./snapshot";

const REGISTRY = "__worlds";

export interface PersonaSpec {
  /** Clone key (`a`, `b`…): ids `cus-<worldId>-<key>`. */
  readonly key: string;
  readonly model: string;
  readonly emailOverride?: "bounce" | "complaint";
}

export interface WorldSpec {
  /** Second world of a scenario (`sc03-up`): suffix of its id. */
  readonly suffix?: string;
  readonly template?: "models" | "guest";
  readonly personas?: readonly PersonaSpec[];
  readonly settings?: WorldSettingsOverride;
  /** Earlier money actions of the personas (FL-040: two reversals this month). */
  readonly history?: readonly HistoryEntry[];
}

export interface CreatedWorld {
  readonly worldId: string;
  readonly epoch: number;
  readonly template: "models" | "guest";
  /** Clone key → customer id. */
  readonly customers: Readonly<Record<string, string>>;
  /** Clone key → model persona. */
  readonly models: Readonly<Record<string, string>>;
  readonly createMs: number;
}

export function createdWorlds(state: Record<string, unknown>): string[] {
  return (state[REGISTRY] as string[] | undefined) ?? [];
}

function register(ctx: ScenarioContext, worldId: string): void {
  const registered = createdWorlds(ctx.state);
  if (!registered.includes(worldId)) ctx.state[REGISTRY] = [...registered, worldId];
}

/** `cus-<worldId>-<key>` (qa-driver/world-models.ts `cloneCustomerId`). */
export const cloneCustomerId = (worldId: string, key: string): string => `cus-${worldId}-${key}`;

/** Models a request clones more than once (the driver refuses them: one clone per model and world). */
export function duplicateModels(personas: readonly Pick<PersonaSpec, "model">[]): string[] {
  const models = personas.map((persona) => persona.model);
  return [...new Set(models.filter((model, index) => models.indexOf(model) !== index))];
}

/** Creates the world and waits until `READY` (the factory runs by blocks of 50 s; a guest world takes minutes). */
export async function createWorld(ctx: ScenarioContext, spec: WorldSpec = {}): Promise<CreatedWorld> {
  const scenario = spec.suffix === undefined ? ctx.scenario.slug : `${ctx.scenario.slug}-${spec.suffix}`;
  const worldId = `qa-${ctx.runId}-${scenario}`;
  register(ctx, worldId);
  const template = spec.template ?? "models";
  const personas = (spec.personas ?? []).map((persona) => ({ key: persona.key, model: persona.model, ...(persona.emailOverride ? { emailOverride: persona.emailOverride } : {}) }));
  const twice = duplicateModels(personas);
  // The driver clones a model once per world (DUPLICATE_MODEL): a second clone goes to a world of its own.
  if (twice.length > 0) throw new Error(`${worldId} clones ${twice.join(", ")} twice: give the second clone a world with a suffix`);
  const step = ctx.repeatable("world.create", {
    runId: ctx.runId,
    scenario,
    template,
    personas,
    ...(spec.settings ? { settings: spec.settings } : {}),
    ...(spec.history && spec.history.length > 0 ? { history: [...spec.history] } : {}),
  });
  const started = ctx.now();
  const ready = (await ctx.eventually(
    `${worldId} READY`,
    async () => {
      const answer = (await step()) as { state: string; epoch?: number };
      return answer.state === "READY" ? answer : undefined;
    },
    WAITS.worldSec,
    template === "guest" ? WAITS.worldEverySec : 2,
  )) as { epoch: number };
  const createMs = ctx.now() - started;
  ctx.measure(spec.suffix === undefined ? "worldCreateMs" : `worldCreateMs.${spec.suffix}`, createMs);
  const world: CreatedWorld = {
    worldId,
    epoch: ready.epoch,
    template,
    customers: Object.fromEntries(personas.map((persona) => [persona.key, cloneCustomerId(worldId, persona.key)])),
    models: Object.fromEntries(personas.map((persona) => [persona.key, persona.model])),
    createMs,
  };
  ctx.state[`world:${spec.suffix ?? "main"}`] = world;
  ctx.note(spec.suffix === undefined ? "world" : `world-${spec.suffix}`, worldId);
  return world;
}

export function worldOf(ctx: ScenarioContext, suffix = "main"): CreatedWorld {
  const world = ctx.state[`world:${suffix}`] as CreatedWorld | undefined;
  if (world === undefined) throw new Error(`${ctx.scenario.id} has no world "${suffix}" yet`);
  return world;
}

/** The customer id of a clone key in the scenario's world. */
export function customerOf(ctx: ScenarioContext, key: string, suffix = "main"): string {
  const customerId = worldOf(ctx, suffix).customers[key];
  if (customerId === undefined) throw new Error(`${ctx.scenario.id} has no persona "${key}"`);
  return customerId;
}

/** The world quiet, then the clock to `to`. */
export async function advanceTo(ctx: ScenarioContext, worldId: string, to: string): Promise<void> {
  await ctx.settled(worldId);
  await ctx.qa("clock.advanceTo", { worldId, to });
}

/** The world quiet, then the clock by `minutes`. */
export async function advanceBy(ctx: ScenarioContext, worldId: string, minutes: number): Promise<void> {
  await ctx.settled(worldId);
  await ctx.qa("clock.advance", { worldId, minutes });
}

/** The world quiet, then ONE "Avanzar al próximo evento" (of a complaint, when given). */
export async function advanceToNext(ctx: ScenarioContext, worldId: string, complaintId?: string): Promise<unknown> {
  await ctx.settled(worldId);
  return ctx.qa("clock.advanceToNext", { worldId, ...(complaintId === undefined ? {} : { complaintId }) });
}

/** A milestone of a complaint as its timeline shows it (status and who fired it). */
export async function milestoneOf(ctx: ScenarioContext, worldId: string, complaintId: string, milestone: string) {
  const timeline = await timelineOf(ctx, worldId, complaintId);
  return itemsOf(timeline, "MILESTONE").find((item) => item.milestone === milestone);
}

/**
 * The Scheduler step (SMK/5, SC-15/7): one atomic `clock.unfreeze` leaves the milestone `leadSec × rate`
 * simulated seconds ahead with its schedule created; the real schedule fires it (`firedBy SCHEDULER`);
 * the world goes back to PAUSED whatever happens.
 */
export async function schedulerProbe(ctx: ScenarioContext, worldId: string, complaintId: string, milestone: string, rate = 1): Promise<void> {
  const before = await milestoneOf(ctx, worldId, complaintId, milestone);
  ensure(before !== undefined && before.status === "SCHEDULED", `${complaintOwner(complaintId)} has no SCHEDULED ${milestone}`);
  await ctx.settled(worldId);
  const timerKey = timerKeyOf(worldId, before.kind, before.timerId);
  try {
    const armed = (await ctx.qa("clock.unfreeze", { worldId, timerKey, leadSec: 120, rate })) as { dueAtSim: string; dueAtReal: string };
    ctx.note("scheduledTimer", before.timerId);
    ctx.note("dueAtReal", armed.dueAtReal);
    const fired = await ctx.eventually(
      `${milestone} fired by the Scheduler`,
      async () => {
        const item = await milestoneOf(ctx, worldId, complaintId, milestone);
        return item?.status === "FIRED" ? item : undefined;
      },
      WAITS.schedulerSec,
      10,
    );
    ctx.check(fired.firedBy === "SCHEDULER", `${milestone} was fired by ${fired.firedBy ?? "nobody"}, expected SCHEDULER`);
    ctx.check(fired.firedAtSim === null || Date.parse(fired.firedAtSim) === Date.parse(before.atSim), `${milestone} ran at ${fired.firedAtSim} instead of its due instant ${before.atSim}`);
  } finally {
    await ctx.qa("clock.freeze", { worldId });
  }
}

export interface CleanupOutcome {
  readonly audits: Array<{ readonly worldId: string; readonly violations: number | null }>;
  readonly usage: Array<{ readonly worldId: string; readonly turns: number }>;
  readonly errors: string[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Per world: turns used, its policy audit (0 violations expected) and its destruction; one failure never skips the rest. */
export async function cleanupWorlds(ctx: ScenarioContext): Promise<CleanupOutcome> {
  const outcome: CleanupOutcome = { audits: [], usage: [], errors: [] };
  for (const worldId of createdWorlds(ctx.state)) {
    try {
      const snapshot = await ctx.snapshot(worldId);
      outcome.usage.push({ worldId, turns: snapshot.turnsToday });
    } catch (error) {
      outcome.errors.push(`snapshot ${worldId}: ${messageOf(error)}`);
    }
    let violations: number | null = null;
    try {
      const audit = (await ctx.qa("policyAudit.run", { worldId })) as { violations: readonly unknown[] };
      violations = audit.violations.length;
    } catch (error) {
      outcome.errors.push(`policyAudit.run ${worldId}: ${messageOf(error)}`);
    }
    outcome.audits.push({ worldId, violations });
    try {
      const destroy = ctx.repeatable("world.destroy", { worldId });
      await ctx.eventually(`${worldId} destroyed`, async () => ((await destroy()) as { state: string }).state === "DESTROYED", WAITS.worldSec, 2);
    } catch (error) {
      outcome.errors.push(`world.destroy ${worldId}: ${messageOf(error)}`);
    }
  }
  return outcome;
}
