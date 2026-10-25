// Clock, Scheduler and console actions of the QaDriver (docs/tool-catalog.md, docs/architecture.md §7, §10):
//
//   clock.advance … fireNow   the console's own procedures as `OPERATOR` (no `WORLD_BUSY` gate for the
//                             in-process caller: the runner settles first)
//   clock.unfreeze            the real Scheduler, atomically: a PAUSED clock moved to `dueAtSim − leadSec × rate`,
//                             set RUNNING and its schedules created in the same invocation
//   clock.freeze              PAUSED again, every schedule deleted
//   schedule.fireStale        `ScheduleDispatch` with an old version or epoch (FL-081): it decides from the
//                             stored timer and clock, so the fire is discarded without effect
//   conv.settleProbe          the world (or one conversation) quiet, in ≤ 30 s: `{settled, pending[]}`
//   console                   any appRouter procedure; `clock.reset` writes the request without the
//                             console's 10-minute limit and invokes WorldJanitor, as the router does
import { ToolError } from "@reclamo/shared";
import { advanceClock } from "../clock/advance";
import { type WorldPending, worldPending } from "../clock/busy";
import { pause, setRunning } from "../clock/running";
import { dueAtRealOf, readClock, simIso, viewOf } from "../clock/state";
import { ulid } from "../lib/crypto";
import { scheduleNameOf } from "../timers/schedule-name";
import { requestWorldReset } from "../worlds/reset";
import { SETTLE_PROBE_MS } from "./contract";
import { runConsole } from "./console";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";

const QA_CALLER = { actor: "QA" as const };
const SETTLE_POLL_MS = 2_000;

function worldOf(ctx: ActionContext): string {
  if (ctx.worldId === undefined) throw new ToolError("INVALID", "this action needs its world");
  return ctx.worldId;
}

function asOperator(ctx: ActionContext, procedure: string, input?: unknown): Promise<unknown> {
  return runConsole(ctx.ports.console(), { worldId: worldOf(ctx), procedure, role: "OPERATOR", ...(input === undefined ? {} : { input }) }, ctx.log.correlationId);
}

export const clockAdvance = (input: QaInput<"clock.advance">, ctx: ActionContext) => asOperator(ctx, "clock.advance", { minutes: input.minutes });
export const clockAdvanceTo = (input: QaInput<"clock.advanceTo">, ctx: ActionContext) => asOperator(ctx, "clock.advanceTo", { to: input.to });
export const clockAdvanceToNext = (input: QaInput<"clock.advanceToNext">, ctx: ActionContext) =>
  asOperator(ctx, "clock.advanceToNext", input.complaintId === undefined ? {} : { complaintId: input.complaintId });
export const clockAdvanceBusinessDay = (_input: QaInput<"clock.advanceBusinessDay">, ctx: ActionContext) => asOperator(ctx, "clock.advanceBusinessDay", {});
export const clockFireNow = (input: QaInput<"clock.fireNow">, ctx: ActionContext) => asOperator(ctx, "clock.fireNow", { kind: input.kind, timerId: input.timerId });

export async function clockUnfreeze(input: QaInput<"clock.unfreeze">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const deps = ctx.ports.clock(ctx.log);
  const timer = await deps.connector.timers.getByKey(worldId, input.timerKey);
  if (timer === undefined || timer.status !== "SCHEDULED") throw new ToolError("CONFLICT", "that timer is not pending", "TIMER_NOT_SCHEDULED");
  const view = viewOf(await readClock(deps.connector, worldId), ctx.ports.now());
  if (view.running) throw new ToolError("CONFLICT", "clock.unfreeze starts from a paused clock", "CLOCK_RUNNING");
  const target = Date.parse(timer.dueAtSim) - input.leadSec * input.rate * 1_000;
  if (target > view.simNow.getTime()) await advanceClock({ worldId, move: { kind: "advanceTo", to: simIso(new Date(target)) }, caller: QA_CALLER }, deps);
  const changed = await setRunning({ worldId, rate: input.rate, caller: QA_CALLER }, deps);
  const dueAtReal = dueAtRealOf(await readClock(deps.connector, worldId), timer.dueAtSim);
  return { timerKey: input.timerKey, dueAtSim: timer.dueAtSim, dueAtReal: dueAtReal.toISOString(), schedules: changed.resync };
}

export async function clockFreeze(_input: QaInput<"clock.freeze">, ctx: ActionContext): Promise<unknown> {
  return pause({ worldId: worldOf(ctx), caller: QA_CALLER }, ctx.ports.clock(ctx.log));
}

export async function scheduleFireStale(input: QaInput<"schedule.fireStale">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const { data } = ctx.ports;
  const timer = await data.timers.getByKey(worldId, input.timerKey);
  const dueAtSim = timer?.dueAtSim ?? simIso(viewOf(await readClock(data, worldId), ctx.ports.now()).simNow);
  const scheduleArn = ctx.ports.scheduleDispatch.scheduleArn(scheduleNameOf(worldId, input.epoch, input.timerKey));
  const answer = await ctx.ports.scheduleDispatch.invoke({ worldId, timerKey: input.timerKey, version: input.version, epoch: input.epoch, dueAtSim, scheduleArn });
  return { answer, storedVersion: timer?.version ?? null, storedStatus: timer?.status ?? null };
}

function ofCustomer(item: WorldPending, customerId: string | undefined, tokens: ReadonlySet<string>): boolean {
  if (customerId === undefined) return true;
  return item.kind !== "EVENT" || tokens.has(item.detail);
}

/** What the world (or the conversation) still waits for, without the stale items. */
async function pendingNow(ctx: ActionContext, worldId: string, customerId: string | undefined): Promise<WorldPending[]> {
  const { data } = ctx.ports;
  const now = ctx.ports.now();
  const view = viewOf(await readClock(data, worldId), now);
  const pending = (await worldPending(data, view, now)).filter((item) => !item.stale);
  if (customerId === undefined) return pending;
  const state = await data.runtime.getWorldState(worldId);
  const own = new Set(state.inFlight.filter((token) => token.startsWith(`${customerId}#`)).map((token) => token.slice(customerId.length + 1).replace(/~\d+$/, "")));
  return pending.filter((item) => ofCustomer(item, customerId, own));
}

export async function convSettleProbe(input: QaInput<"conv.settleProbe">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const deadline = ctx.startedAt + SETTLE_PROBE_MS;
  // Bounded by polls as well as by time: the answer comes within SETTLE_PROBE_MS whatever the clock does.
  for (let poll = 1; ; poll += 1) {
    const pending = await pendingNow(ctx, worldId, input.customerId);
    if (pending.length === 0) return { settled: true, pending: [] };
    if (poll * SETTLE_POLL_MS >= SETTLE_PROBE_MS || ctx.ports.now().getTime() + SETTLE_POLL_MS >= deadline) {
      return { settled: false, pending: pending.map((item) => ({ kind: item.kind, detail: item.detail, sinceReal: item.sinceReal })) };
    }
    await ctx.ports.sleep(SETTLE_POLL_MS);
  }
}

/** `clock.reset` of a QA world: the request half without the console's interval, then WorldJanitor. */
async function resetWorld(ctx: ActionContext, worldId: string): Promise<unknown> {
  const { data } = ctx.ports;
  const requested = await requestWorldReset({ connector: data, now: ctx.ports.now, newId: () => ulid(ctx.ports.now().getTime()) }, { worldId, actor: "QA" });
  try {
    await ctx.ports.janitor.invoke({ kind: "WORLD_RESET", worldId, requestId: requested.requestId });
  } catch (error) {
    // The request stands: WorldJanitor's hourly pass resumes a RESETTING world without a heartbeat.
    ctx.log.error("qa_driver.reset_invoke_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
  return { status: "RESETTING", requestId: requested.requestId };
}

export async function consoleAction(input: QaInput<"console">, ctx: ActionContext): Promise<unknown> {
  // A role or a sign-in the router would refuse still goes through the router (SC-18: COMPLIANCE gets 403).
  if (input.procedure === "clock.reset" && input.role !== "COMPLIANCE" && input.authTime === undefined) return resetWorld(ctx, input.worldId);
  return runConsole(ctx.ports.console(), input, ctx.log.correlationId);
}
