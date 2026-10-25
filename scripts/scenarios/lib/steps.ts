// Scenarios, steps and the context a step runs with (docs/test-plan.md §4). Every step declares the flows
// it proves (`flows: ["FL-xxx", …]`, what `npm run flows:check` looks for) and talks to the stage only
// through the `QaDriver`. The context enforces the rules of §4.3 and §4.4:
//
//   - every call carries `<runId>/<scenario>/<step>/<label>`: changing calls are labelled `m1`, `m2`… in
//     order and reads `r1`, `r2`…, so a step re-run under the same run id replays its effects; a change
//     polled as a probe (`world.create`, `world.destroy`, `guest.expireNow`) keeps ONE key for every poll;
//   - a negative ("none") or an exact count ("exactly") is only asserted on something read by `settled()`
//     or `quietRead()` after the last changing call of the step: the world quiet means two
//     `conv.settleProbe` answers `settled` 10 s apart; anything else is an error of the scenario itself;
//   - assertions are on persisted state, the register and the tape, never on the model's wording.
import { type QaActionName, type QaResponse, idempotencyKeyOf } from "@reclamo/bff/qa-driver/contract";
import type { ACTION_INPUTS } from "@reclamo/bff/qa-driver/inputs";
import type { z } from "zod";
import { isRead, type DriverClient } from "./driver-client";
import { QUIET_GAP_SEC, WAITS, eventually, realSleep } from "./eventually";
import type { Snapshot } from "./snapshot";

export type Suite = "smoke" | "full";

/** An action's input as a scenario writes it (defaults of the driver's schema may be left out). */
export type QaInput<A extends QaActionName> = z.input<(typeof ACTION_INPUTS)[A]>;

/** Where a block of hostile or refused content came from (docs/test-plan.md §4.3, last paragraph). */
export type BlockOrigin = "PREFILTER_G1" | "HARNESS_G1" | "CEDAR" | "LAMBDA_FENCE" | "CHANNEL_POLICY" | "G2" | "VERIFY" | "OBLIGATION" | "MODEL_REFUSAL";

export interface StepDef {
  /** The number the flows catalog cites (`SC-01/2` is step 2); 0 for a setup step without flows. */
  readonly n: number;
  readonly title: string;
  readonly flows: readonly string[];
  readonly run: (ctx: ScenarioContext) => Promise<void>;
}

export interface ScenarioDef {
  readonly id: string;
  /** Lower-case slug of keys and worlds (`sc01`); a second world of the scenario is `<slug>-<suffix>`. */
  readonly slug: string;
  readonly title: string;
  readonly suites: readonly Suite[];
  /** Scenarios of one lane run one after the other (docs/test-plan.md §4.4: SC-22 before SC-21). */
  readonly lane?: string;
  /** Place inside its lane, lowest first (file order otherwise). */
  readonly laneOrder?: number;
  /** Runs alone after the parallel part. */
  readonly alone?: boolean;
  /** Runs alone after every other scenario (SC-20 aggregates their audits). */
  readonly last?: boolean;
  /** Runs only when asked by name (`--scenario`), never in a suite (SC-23 needs `--live`, the light load). */
  readonly onDemand?: boolean;
  readonly steps: readonly StepDef[];
  /** Always runs, also after a failure (`dlq.delete`, a final reset), before the worlds are destroyed. */
  readonly cleanup?: (ctx: ScenarioContext) => Promise<void>;
}

export function defineScenario(scenario: ScenarioDef): ScenarioDef {
  const numbers = scenario.steps.map((step) => step.n);
  if (new Set(numbers).size !== numbers.length) throw new RangeError(`${scenario.id} repeats a step number`);
  if (!/^(?:sc\d{2}|smk)$/.test(scenario.slug)) throw new RangeError(`${scenario.id}: slug must be sc<nn> or smk`);
  return scenario;
}

/** The driver refused or failed: code and reason as it answered them. */
export class DriverRefusal extends Error {
  override readonly name = "DriverRefusal";
  constructor(
    readonly action: QaActionName,
    readonly code: string,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(`${action}: ${code}${reason === undefined ? "" : `/${reason}`} ${message}`);
  }
}

/** A mistake of the scenario itself (a negative before the world was quiet, a missing world). */
export class ScenarioBug extends Error {
  override readonly name = "ScenarioBug";
}

export class AssertionFailed extends Error {
  override readonly name = "AssertionFailed";
}

/** An assertion that also narrows the type. */
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailed(message);
}

export interface StepRecord {
  readonly ids: Record<string, string>;
  readonly blocks: Array<{ readonly origin: BlockOrigin; readonly detail: string }>;
  readonly warnings: string[];
  /** Durations and latencies the report publishes (`ackLatencyMs`, `worldCreateMs`…). */
  readonly measures: Record<string, number>;
}

export const emptyRecord = (): StepRecord => ({ ids: {}, blocks: [], warnings: [], measures: {} });

/** A changing action polled as a probe: every poll reuses the key it got once. */
export type Repeatable = () => Promise<unknown>;

export interface ScenarioContext {
  readonly runId: string;
  readonly scenario: ScenarioDef;
  readonly step: number;
  /** Values steps pass to later steps (worlds, complaint ids, mail ids, baselines). */
  readonly state: Record<string, unknown>;
  /** Results of the scenarios that ran before (SC-20 aggregates their policy audits). */
  readonly previous: readonly { readonly scenario: string; readonly violations: number; readonly unaudited: number }[];
  qa<A extends QaActionName>(action: A, input: QaInput<A>): Promise<any>;
  /** The driver's answer as it is, for an expected refusal. */
  attempt<A extends QaActionName>(action: A, input: QaInput<A>): Promise<QaResponse<any>>;
  /** One key for every poll of a changing action that answers an interim `state`. */
  repeatable<A extends QaActionName>(action: A, input: QaInput<A>): Repeatable;
  snapshot(worldId: string, customerId?: string): Promise<Snapshot>;
  /** The world (or the conversation) quiet, then a snapshot: what negatives and exact counts accept. */
  settled(worldId: string, customerId?: string, timeoutSec?: number): Promise<Snapshot>;
  /** The world quiet, then `read()`: its result is accepted by `none` and `exactly`. */
  quietRead<T extends object>(worldId: string, read: () => Promise<T>, customerId?: string): Promise<T>;
  eventually<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutSec: number, everySec?: number): Promise<T>;
  /** Real time (injected by the tests). */
  now(): number;
  check(condition: unknown, message: string): void;
  none<T>(proof: object, what: string, items: readonly T[]): void;
  exactly<T>(proof: object, count: number, what: string, items: readonly T[]): T[];
  blocked(origin: BlockOrigin, detail: string): void;
  note(name: string, value: string): void;
  measure(name: string, value: number): void;
  warn(message: string): void;
}

export interface ContextOptions {
  readonly runId: string;
  readonly scenario: ScenarioDef;
  readonly driver: DriverClient;
  readonly state: Record<string, unknown>;
  readonly previous?: ScenarioContext["previous"];
  readonly waitOptions?: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };
}

interface SettleAnswer {
  readonly settled: boolean;
  readonly pending: readonly unknown[];
}

/** Context of one step; `record` collects what the report shows for it. */
export function stepContext(options: ContextOptions, step: number, record: StepRecord): ScenarioContext {
  let changes = 0;
  let reads = 0;
  const now = options.waitOptions?.now ?? Date.now;
  const sleep = options.waitOptions?.sleep ?? realSleep;
  // Something read after the world was quiet → the number of changing calls when it was read.
  const quietAt = new WeakMap<object, number>();

  function keyFor(changing: boolean): string {
    const label = changing ? `m${++changes}` : `r${++reads}`;
    return idempotencyKeyOf({ runId: options.runId, scenario: options.scenario.slug, step, label });
  }

  function call<A extends QaActionName>(action: A, input: QaInput<A>, key = keyFor(!isRead(action, input))): Promise<QaResponse<any>> {
    return options.driver.call(action, input, key);
  }

  function unwrap<A extends QaActionName>(action: A, answer: QaResponse<any>): any {
    if (!answer.ok) throw new DriverRefusal(action, answer.error.code, answer.error.reason, answer.error.message);
    return answer.result;
  }

  function requireQuiet(proof: object, what: string): void {
    const at = quietAt.get(proof);
    if (at === undefined || at !== changes) throw new ScenarioBug(`"${what}" is a negative or an exact count: assert it on what settled() or quietRead() read after the last change`);
  }

  async function quiet(worldId: string, customerId: string | undefined, timeoutSec: number): Promise<void> {
    let quietSince: number | undefined;
    await eventually(
      `${worldId}${customerId === undefined ? "" : ` (${customerId})`} quiet`,
      async () => {
        const probe = unwrap("conv.settleProbe", await call("conv.settleProbe", { worldId, ...(customerId === undefined ? {} : { customerId }) })) as SettleAnswer;
        if (!probe.settled) {
          quietSince = undefined;
          return false;
        }
        if (quietSince !== undefined && now() - quietSince >= QUIET_GAP_SEC * 1_000) return true;
        quietSince ??= now();
        return false;
      },
      { timeoutSec, everySec: QUIET_GAP_SEC, now, sleep },
    );
  }

  const ctx: ScenarioContext = {
    runId: options.runId,
    scenario: options.scenario,
    step,
    state: options.state,
    previous: options.previous ?? [],
    async qa(action, input) {
      return unwrap(action, await call(action, input));
    },
    attempt: (action, input) => call(action, input),
    repeatable(action, input) {
      const key = keyFor(true);
      return async () => unwrap(action, await call(action, input, key));
    },
    async snapshot(worldId, customerId) {
      return (await ctx.qa("snapshot", { worldId, ...(customerId === undefined ? {} : { customerId }) })) as Snapshot;
    },
    async settled(worldId, customerId, timeoutSec = WAITS.settleSec) {
      await quiet(worldId, customerId, timeoutSec);
      const snapshot = await ctx.snapshot(worldId, customerId);
      quietAt.set(snapshot, changes);
      return snapshot;
    },
    async quietRead(worldId, read, customerId) {
      await quiet(worldId, customerId, WAITS.settleSec);
      const result = await read();
      quietAt.set(result, changes);
      return result;
    },
    eventually(what, probe, timeoutSec, everySec) {
      return eventually(what, probe, { timeoutSec, ...(everySec === undefined ? {} : { everySec }), now, sleep });
    },
    now,
    check(condition, message) {
      ensure(condition, message);
    },
    none(proof, what, items) {
      requireQuiet(proof, what);
      if (items.length > 0) throw new AssertionFailed(`expected no ${what}, found ${items.length}`);
    },
    exactly(proof, count, what, items) {
      requireQuiet(proof, what);
      if (items.length !== count) throw new AssertionFailed(`expected exactly ${count} ${what}, found ${items.length}`);
      return [...items];
    },
    blocked(origin, detail) {
      record.blocks.push({ origin, detail });
    },
    note(name, value) {
      record.ids[name] = value;
    },
    measure(name, value) {
      record.measures[name] = value;
    },
    warn(message) {
      record.warnings.push(message);
    },
  };
  return ctx;
}

/**
 * A step whose stage path the driver does not offer yet: the report shows it BLOCKED (never a pass) with
 * what is missing, the way a `NOT_WIRED` refusal of the driver does.
 */
export function notWired(action: QaActionName, missing: string): never {
  throw new DriverRefusal(action, "UNAVAILABLE", "NOT_WIRED", missing);
}
