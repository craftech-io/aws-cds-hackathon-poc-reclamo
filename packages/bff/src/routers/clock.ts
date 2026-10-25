// `clock` router (docs/tool-catalog.md "Procedimientos de la consola", `advance_clock`,
// `reset_world`; docs/architecture.md §10; ADR-0011; FL-082, FL-100): the demo clock of the
// principal's world, its timers and its reset.
//
//   get                 mode, simulated now, rate and live window, the next timers, and whether the world
//                       is busy (with what it waits for and from when "Avanzar igual" is accepted)
//   advance / advanceTo / advanceToNext({complaintId?}) / advanceBusinessDay / fireNow
//                       clock/advance.ts: forward only, at most 20 days, every timer fired in order at its
//                       own `dueAtSim`; from the console the world must be quiet (`WORLD_BUSY`, `force`
//                       once the oldest pending item waited 5 real minutes, audited `CLOCK_FORCED`); the
//                       QaDriver's in-process caller passes no gate. `fireNow` moves to one timer's instant
//   setRunning / pause  clock/running.ts: "Reloj en vivo" at `rate` 1 to 2,880 for 30 real minutes
//   reset               writes ONLY the request (worlds/reset.ts: `READY → RESETTING`, epoch + 1, tombstone,
//                       ticket `RESETREQ#`, audit, one transaction; one every 10 real minutes, and in a
//                       self-signup world at most 3 per real day, `RESET_DAILY_CAP`), invokes
//                       `WorldJanitor` asynchronously with `{kind, worldId, requestId}` and answers
//                       `{status: RESETTING, requestId}` with HTTP 202; the work never runs in the request
//                       (nothing here reaches worlds/factory.ts)
//   resetStatus         the only procedure answered while the world is `RESETTING` (trpc.ts): status,
//                       phase and start, for the console's poll
import { z } from "zod";
import { IsoInstant, ToolError } from "@reclamo/shared";
import { actorOf } from "../auth/audit";
import { type ClockCaller, type ClockDeps, type ClockMove, advanceClock } from "../clock/advance";
import { FORCE_AFTER_MS, type WorldPending, worldPending } from "../clock/busy";
import { QA_MAX_RATE, pause, refreshClock, setRunning } from "../clock/running";
import { readClock, simIso, viewOf } from "../clock/state";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import { Actor, Id } from "../domain/common";
import { ulid } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { linkedNetworkClient } from "../networks/linked";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { enqueuerSink } from "../timers/sink";
import { linkedEnqueuer } from "../worker/enqueue";
import type { JanitorInvoker } from "../worlds/deps";
import { requestWorldReset } from "../worlds/reset";
import { lambdaJanitorInvoker } from "../worlds/stage";
import type { ContextDeps } from "./deps";
import { accessProcedure } from "./roles";
import { type WorldContext, acceptedAsync, router } from "./trpc";

/** What the clock router reaches; tests and the local UI server bind their own. */
export interface ClockPorts {
  readonly connector: Connector;
  /** The timers' deps of one request: queue, networks, Scheduler, logger, real clock. */
  readonly timers: (log: Logger) => ClockDeps;
  /** `WorldJanitor`, invoked asynchronously with the reset ticket. */
  readonly janitor: JanitorInvoker;
}

declare module "./deps" {
  interface ContextDeps {
    /** `clock.*` (routers/clock.ts); the linked resources when absent. */
    readonly clockPorts?: ClockPorts;
  }
}

/** One reset request per world every 10 real minutes from the console (docs/architecture.md §10). */
export const RESET_INTERVAL_MS = 10 * 60_000;
/** Timers `clock.get` lists. */
const UPCOMING = 10;

/** The code of what a busy world waits for, by its oldest pending item; the console words it from copy. */
export const BUSY_REASON: Readonly<Record<WorldPending["kind"], string>> = { EVENT: "EVENT_IN_FLIGHT", MAIL: "EMAIL_PENDING", SCAN: "SCAN_PENDING", TIMER: "TIMER_DUE" };

function stageTimers(connector: Connector): ClockPorts["timers"] {
  const scheduler = eventBridgeScheduler();
  // Resolved on the first publication or transfer change: a move that fires neither never reads the link.
  const networks: ClockDeps["networks"] = {
    publishSettlement: (...args) => linkedNetworkClient().publishSettlement(...args),
    transitionTransfer: (...args) => linkedNetworkClient().transitionTransfer(...args),
  };
  return (log) => ({ connector, sink: enqueuerSink(linkedEnqueuer(connector, log)), networks, scheduler, log, realNow: () => new Date() });
}

let stagePorts: ClockPorts | undefined;

function clockPortsOf(deps: ContextDeps): ClockPorts {
  if (deps.clockPorts) return deps.clockPorts;
  const connector = dynamoConnector();
  stagePorts ??= { connector, timers: stageTimers(connector), janitor: lambdaJanitorInvoker(createLogger({ bindings: { service: "bff" } })) };
  return stagePorts;
}

function callerOf(ctx: WorldContext, force: boolean | undefined): ClockCaller {
  const actor = Actor.parse(actorOf(ctx.principal));
  // The QaDriver settles the world itself and passes no gate (docs/tool-catalog.md, QaDriver).
  return { actor, correlationId: ctx.correlationId, ...(ctx.inProcess ? {} : { gate: { force: force ?? false } }) };
}

function moveClock(ctx: WorldContext, move: ClockMove, force: boolean | undefined) {
  const ports = clockPortsOf(ctx.deps);
  return advanceClock({ worldId: ctx.principal.worldId, move, caller: callerOf(ctx, force) }, ports.timers(ctx.log));
}

const Force = { force: z.boolean().optional() };

/** A jump of simulated time, at most 20 days (docs/architecture.md §10). */
export const ClockAdvanceInput = z.object({ minutes: z.number().int().min(1).max(20 * 24 * 60), ...Force }).strict();
export const ClockAdvanceToInput = z.object({ to: IsoInstant, ...Force }).strict();
/** The next due timer of the world, or of one complaint ("Avanzar al próximo hito de este reclamo"). */
export const ClockAdvanceToNextInput = z.object({ complaintId: Id.optional(), ...Force }).strict().optional();
export const ClockForceInput = z.object(Force).strict().optional();
/** The console's ceiling (2,880) is clock/running.ts `validRate`'s: only the QaDriver goes beyond, in `qa-*`. */
export const ClockSetRunningInput = z.object({ rate: z.number().int().min(1).max(QA_MAX_RATE).optional(), ...Force }).strict().optional();
export const ClockFireNowInput = z.object({ kind: z.string().regex(/^[A-Z_]{2,40}$/), timerId: Id, ...Force }).strict();

export const clockRouter = router({
  get: accessProcedure("clock.get").query(async ({ ctx }) => {
    const ports = clockPortsOf(ctx.deps);
    const { worldId } = ctx.principal;
    const realNow = ctx.deps.wallClock();
    let stored = await readClock(ports.connector, worldId);
    // A live window that ended is written back PAUSED (and its schedules deleted) before it is shown.
    if (viewOf(stored, realNow).expired) {
      await refreshClock({ worldId }, ports.timers(ctx.log));
      stored = await readClock(ports.connector, worldId);
    }
    const view = viewOf(stored, realNow);
    const [upcoming, pending] = await Promise.all([ports.connector.timers.listDue(worldId, { limit: UPCOMING }), worldPending(ports.connector, view, realNow)]);
    const waiting = pending.filter((item) => !item.stale);
    const oldest = [...waiting].sort((a, b) => Date.parse(a.sinceReal) - Date.parse(b.sinceReal))[0];
    return {
      worldId,
      worldEpoch: stored.worldEpoch,
      mode: view.running ? ("RUNNING" as const) : ("PAUSED" as const),
      simNow: simIso(view.simNow),
      ...(view.running && stored.rate !== undefined ? { rate: stored.rate } : {}),
      ...(view.running && stored.runningUntilReal !== undefined ? { runningUntilReal: stored.runningUntilReal } : {}),
      upcoming: upcoming.map((timer) => ({ kind: timer.kind, timerId: timer.timerId, dueAtSim: timer.dueAtSim, ownerKey: timer.ownerKey ?? null, complaintId: timer.ownerKey?.startsWith("CMP#") ? timer.ownerKey.slice(4) : null })),
      // `null` when the world is quiet; else what it waits for (the oldest first names the reason).
      busy:
        oldest === undefined
          ? null
          : { reason: BUSY_REASON[oldest.kind], pending: waiting, forceAllowedAtReal: new Date(Date.parse(oldest.sinceReal) + FORCE_AFTER_MS).toISOString() },
    };
  }),

  advance: accessProcedure("clock.advance")
    .input(ClockAdvanceInput)
    .mutation(({ ctx, input }) => moveClock(ctx, { kind: "advance", minutes: input.minutes }, input.force)),

  advanceTo: accessProcedure("clock.advanceTo")
    .input(ClockAdvanceToInput)
    .mutation(({ ctx, input }) => moveClock(ctx, { kind: "advanceTo", to: input.to }, input.force)),

  advanceToNext: accessProcedure("clock.advanceToNext")
    .input(ClockAdvanceToNextInput)
    .mutation(async ({ ctx, input }) => {
      if (input?.complaintId !== undefined) {
        const complaint = await clockPortsOf(ctx.deps).connector.complaints.get(ctx.principal.worldId, input.complaintId);
        if (complaint === undefined) throw new ToolError("NOT_FOUND", "there is no such complaint in this world", "COMPLAINT_NOT_FOUND");
      }
      return moveClock(ctx, { kind: "advanceToNext", ...(input?.complaintId !== undefined ? { complaintId: input.complaintId } : {}) }, input?.force);
    }),

  advanceBusinessDay: accessProcedure("clock.advanceBusinessDay")
    .input(ClockForceInput)
    .mutation(({ ctx, input }) => moveClock(ctx, { kind: "advanceBusinessDay" }, input?.force)),

  setRunning: accessProcedure("clock.setRunning")
    .input(ClockSetRunningInput)
    .mutation(({ ctx, input }) =>
      setRunning({ worldId: ctx.principal.worldId, ...(input?.rate !== undefined ? { rate: input.rate } : {}), caller: callerOf(ctx, input?.force) }, clockPortsOf(ctx.deps).timers(ctx.log)),
    ),

  pause: accessProcedure("clock.pause").mutation(({ ctx }) => pause({ worldId: ctx.principal.worldId, caller: callerOf(ctx, false) }, clockPortsOf(ctx.deps).timers(ctx.log))),

  fireNow: accessProcedure("clock.fireNow")
    .input(ClockFireNowInput)
    .mutation(async ({ ctx, input }) => {
      const ports = clockPortsOf(ctx.deps);
      const { worldId } = ctx.principal;
      const timer = await ports.connector.timers.get({ worldId, kind: input.kind, timerId: input.timerId }, { consistent: true });
      if (timer === undefined || timer.status !== "SCHEDULED") throw new ToolError("CONFLICT", "that timer is not pending", "TIMER_NOT_SCHEDULED");
      const simNow = viewOf(await readClock(ports.connector, worldId), ctx.deps.wallClock()).simNow;
      const to = Math.max(simNow.getTime(), Date.parse(timer.dueAtSim));
      return moveClock(ctx, { kind: "advanceTo", to: simIso(new Date(to)) }, input.force);
    }),

  reset: accessProcedure("clock.reset").mutation(async ({ ctx }) => {
    const ports = clockPortsOf(ctx.deps);
    const { worldId } = ctx.principal;
    const actor = Actor.parse(actorOf(ctx.principal));
    // The request half only (worlds/reset.ts); `RATE_LIMITED` within 10 real minutes of the last reset,
    // `RESET_DAILY_CAP` past the real day's cap of a self-signup world.
    const { requestId } = await requestWorldReset({ connector: ports.connector, now: ctx.deps.wallClock, newId: () => ulid(ctx.deps.wallClock().getTime()) }, { worldId, actor, minIntervalMs: RESET_INTERVAL_MS });
    try {
      await ports.janitor.invoke({ kind: "WORLD_RESET", worldId, requestId });
    } catch (error) {
      // The request stands: WorldJanitor's hourly pass resumes a RESETTING world without a heartbeat.
      ctx.log.error("clock.reset_invoke_failed", { requestId, errorName: error instanceof Error ? error.name : "UnknownError" });
    }
    acceptedAsync(ctx);
    ctx.log.info("clock.reset_requested", { requestId });
    return { status: "RESETTING" as const, requestId };
  }),

  resetStatus: accessProcedure("clock.resetStatus").query(async ({ ctx }) => {
    const meta = await clockPortsOf(ctx.deps).connector.worlds.getMeta(ctx.principal.worldId, { consistent: true });
    if (meta === undefined) throw new ToolError("NOT_FOUND", "this world does not exist", "WORLD_MISSING");
    const { reset } = meta;
    return {
      status: meta.status,
      ...(reset ? { phase: reset.phase, requestId: reset.requestId, startedAtReal: reset.requestedAtReal } : {}),
      ...(meta.lastResetAtReal ? { lastResetAtReal: meta.lastResetAtReal } : {}),
    };
  }),
});
