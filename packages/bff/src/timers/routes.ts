// What a claimed timer does where it was claimed (`ScheduleDispatch` for the Scheduler, the clock's
// caller for `advance_clock`), by kind (docs/architecture.md §7 and §10). Everything here only reads
// complaints, writes timers and enqueues; what writes a complaint or sends a message runs on the
// worker, which serializes it with the rest of the customer's events (effects.ts):
//
//   SETTLEMENT_PUBLISH   NetworkMock publishes the batch's CSV (its Function URL); in the SAME dispatch
//                        the batch's SETTLEMENT_RECHECK timers fire (`firedBy PUBLICATION`, at the
//                        publication instant) and every complaint still AWAITING_SETTLEMENT on the batch
//                        gets its SETTLEMENT_PUBLISHED. A publication the network defers leaves a new
//                        SETTLEMENT_PUBLISH timer at the new instant.
//   SETTLEMENT_RECHECK   the safety net: SETTLEMENT_PUBLISHED for its complaint if it still waits
//   NETWORK_TRANSITION   a transfer changes state in NetworkMock (a disbursement's state comes from the
//                        core's simulated day); TRANSFER_STATUS_CHANGED only for a complaint waiting for it
//   SLA, AUTO_CLOSE,     a `TIMER` event on the customer's queue
//   DEFERRED_SEND,
//   FOLLOW_UP
import { ToolError, type TimerFiredBy } from "@reclamo/shared";
import type { Complaint } from "../domain/complaint";
import type { Timer } from "../domain/timer";
import { isConflict } from "../connector/errors";
import { isNetworkConflict } from "../networks/errors";
import type { TimerDeps } from "./deps";
import {
  NetworkTransitionPayload,
  SettlementPublishPayload,
  SettlementRecheckPayload,
  settlementEventId,
  timerEventId,
  transitionEventId,
} from "./events";

/** What a dispatch did, for the caller's log and answer (ids only). */
export interface DispatchEffect {
  readonly enqueued: readonly string[];
  /** Timers fired along (the batch's rechecks, `firedBy PUBLICATION`). */
  readonly alsoFired: readonly string[];
  readonly note?: "DEFERRED_BY_NETWORK" | "NO_WAITING_COMPLAINT" | "NETWORK_CONFLICT" | "NO_CUSTOMER";
}

export interface FireContext {
  readonly firedBy: TimerFiredBy;
  readonly correlationId?: string;
}

const NONE: DispatchEffect = { enqueued: [], alsoFired: [] };

function timerKeyOf(deps: TimerDeps, timer: Timer): string {
  return deps.connector.timers.timerKey({ worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId });
}

async function complaintOf(deps: TimerDeps, worldId: string, complaintId: string): Promise<Complaint | undefined> {
  return deps.connector.complaints.get(worldId, complaintId, { consistent: true });
}

/** The common fields of a queue event of this timer: its world, epoch and simulated instant. */
function envelope(timer: Timer, customerId: string, eventId: string, context: FireContext) {
  return {
    worldId: timer.worldId,
    customerId,
    eventId,
    epoch: timer.epoch,
    eventAtSim: timer.dueAtSim,
    ...(context.correlationId && CORRELATION.test(context.correlationId) ? { correlationId: context.correlationId } : {}),
  };
}

const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function networksOf(deps: TimerDeps): NonNullable<TimerDeps["networks"]> {
  if (!deps.networks) throw new ToolError("UNAVAILABLE", "this caller cannot reach the networks", "NETWORKS_UNAVAILABLE");
  return deps.networks;
}

/** Claims a recheck along with its batch's publication; `false` when someone else moved it first. */
async function claimAlong(deps: TimerDeps, recheck: Timer, atSim: string): Promise<boolean> {
  try {
    await deps.connector.timers.transition({
      worldId: recheck.worldId,
      kind: recheck.kind,
      timerId: recheck.timerId,
      version: recheck.version,
      from: ["SCHEDULED"],
      to: "FIRED",
      epoch: recheck.epoch,
      firedBy: "PUBLICATION",
      firedAtSim: atSim,
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

async function publishBatch(timer: Timer, firedVersion: number, deps: TimerDeps, context: FireContext): Promise<DispatchEffect> {
  const { network, businessDate } = SettlementPublishPayload.parse(timer.payload);
  const call = { worldId: timer.worldId, simNow: timer.dueAtSim, ...(context.correlationId ? { correlationId: context.correlationId } : {}) };
  const result = await networksOf(deps).publishSettlement(call, network, businessDate);
  if (result.outcome === "DEFERRED") {
    try {
      await deps.connector.timers.put({ ...timer, timerId: `${timer.timerId}-r${firedVersion}`, dueAtSim: result.batch.publishAtSim, status: "SCHEDULED", firedBy: undefined, firedAtSim: undefined, scheduleName: undefined });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    return { ...NONE, note: "DEFERRED_BY_NETWORK" };
  }
  const rechecks = (await deps.connector.timers.listByOwner(timer.worldId, `BATCH#${network}#${businessDate}`)).filter(
    (candidate) => candidate.kind === "SETTLEMENT_RECHECK" && candidate.epoch === timer.epoch,
  );
  const enqueued: string[] = [];
  const alsoFired: string[] = [];
  const done = new Set<string>();
  const notify = async (complaintId: string, eventId: string): Promise<void> => {
    if (done.has(complaintId)) return;
    done.add(complaintId);
    const complaint = await complaintOf(deps, timer.worldId, complaintId);
    if (complaint?.status !== "AWAITING_SETTLEMENT") return;
    await deps.sink.enqueue({ type: "SETTLEMENT_PUBLISHED", ...envelope(timer, complaint.customerId, eventId, context), payload: { complaintId, batchKey: `BATCH#${network}#${businessDate}` } });
    enqueued.push(eventId);
  };
  for (const recheck of rechecks.filter((candidate) => candidate.status === "SCHEDULED")) {
    if (!(await claimAlong(deps, recheck, timer.dueAtSim))) continue;
    alsoFired.push(recheck.timerId);
    const { complaintId } = SettlementRecheckPayload.parse(recheck.payload);
    await notify(complaintId, settlementEventId(timerKeyOf(deps, recheck), recheck.epoch, recheck.version, complaintId));
  }
  // A recheck that fired before (the safety net ran first, or an earlier attempt of this dispatch).
  for (const recheck of rechecks.filter((candidate) => candidate.status !== "SCHEDULED" && candidate.status !== "CANCELLED")) {
    const parsed = SettlementRecheckPayload.safeParse(recheck.payload);
    if (parsed.success) await notify(parsed.data.complaintId, settlementEventId(timerKeyOf(deps, timer), timer.epoch, firedVersion, parsed.data.complaintId));
  }
  return { enqueued, alsoFired };
}

async function recheck(timer: Timer, firedVersion: number, deps: TimerDeps, context: FireContext): Promise<DispatchEffect> {
  const { complaintId } = SettlementRecheckPayload.parse(timer.payload);
  const batch = /^BATCH#(NORTE|SUR)#(\d{4}-\d{2}-\d{2})$/.exec(timer.ownerKey ?? "");
  const complaint = await complaintOf(deps, timer.worldId, complaintId);
  if (!batch?.[1] || !batch[2] || complaint?.status !== "AWAITING_SETTLEMENT") return { ...NONE, note: "NO_WAITING_COMPLAINT" };
  const eventId = settlementEventId(timerKeyOf(deps, timer), timer.epoch, firedVersion, complaintId);
  await deps.sink.enqueue({ type: "SETTLEMENT_PUBLISHED", ...envelope(timer, complaint.customerId, eventId, context), payload: { complaintId, batchKey: batch[0] } });
  return { enqueued: [eventId], alsoFired: [] };
}

/**
 * Whether a waiting complaint is about the transfer or loan of a network transition: its subject (a
 * loan chosen from the list), else the evidence its investigation left (`TRANSFER_STATUS` names the
 * transfer, `DISBURSEMENT` the loan): a complaint filed from free text has no subject.
 */
async function concerns(deps: TimerDeps, complaint: Complaint, payload: NetworkTransitionPayload): Promise<boolean> {
  const [field, id] = "transferId" in payload ? (["transferId", payload.transferId] as const) : (["loanId", payload.loanId] as const);
  if (complaint.subject?.[field] === id) return true;
  const evidence = await deps.connector.caseItems.listEvidence(complaint.worldId, complaint.complaintId);
  const kind = field === "transferId" ? "TRANSFER_STATUS" : "DISBURSEMENT";
  return evidence.some((item) => item.kind === kind && item.details[field] === id);
}

async function networkTransition(timer: Timer, firedVersion: number, deps: TimerDeps, context: FireContext): Promise<DispatchEffect> {
  const payload = NetworkTransitionPayload.parse(timer.payload);
  if ("transferId" in payload) {
    const call = { worldId: timer.worldId, simNow: timer.dueAtSim, ...(context.correlationId ? { correlationId: context.correlationId } : {}) };
    try {
      await networksOf(deps).transitionTransfer(call, payload.transferId, { to: payload.to, ...(payload.rejectReason ? { rejectReason: payload.rejectReason } : {}) });
    } catch (error) {
      // The transfer already moved another way (a reversal): the scheduled change no longer applies.
      if (isNetworkConflict(error)) return { ...NONE, note: "NETWORK_CONFLICT" };
      throw error;
    }
  }
  const awaiting = (await deps.connector.complaints.listOpen(timer.worldId)).filter((complaint) => complaint.status === "AWAITING_NETWORK");
  const waiting: Complaint[] = [];
  for (const complaint of awaiting) if (await concerns(deps, complaint, payload)) waiting.push(complaint);
  const enqueued: string[] = [];
  for (const complaint of waiting) {
    const eventId = transitionEventId(timerKeyOf(deps, timer), timer.epoch, firedVersion, complaint.complaintId);
    await deps.sink.enqueue({
      type: "TRANSFER_STATUS_CHANGED",
      ...envelope(timer, complaint.customerId, eventId, context),
      payload: { complaintId: complaint.complaintId, ...("transferId" in payload ? { transferId: payload.transferId } : {}) },
    });
    enqueued.push(eventId);
  }
  return enqueued.length === 0 ? { ...NONE, note: "NO_WAITING_COMPLAINT" } : { enqueued, alsoFired: [] };
}

function stringField(payload: Timer["payload"], field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" ? value : undefined;
}

/** The worker's kinds: a `TIMER` event on the customer's queue (the customer from the payload or the complaint). */
async function toWorker(timer: Timer, firedVersion: number, deps: TimerDeps, context: FireContext): Promise<DispatchEffect> {
  const complaintId = stringField(timer.payload, "complaintId");
  const customerId = stringField(timer.payload, "customerId") ?? (complaintId ? (await complaintOf(deps, timer.worldId, complaintId))?.customerId : undefined);
  if (!customerId) {
    deps.log.warn("timers.no_customer", { worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId });
    return { ...NONE, note: "NO_CUSTOMER" };
  }
  const timerKey = timerKeyOf(deps, timer);
  const eventId = timerEventId(timerKey, timer.epoch, firedVersion);
  await deps.sink.enqueue({ type: "TIMER", ...envelope(timer, customerId, eventId, context), payload: { kind: timer.kind, timerId: timer.timerId, version: firedVersion, dueAtSim: timer.dueAtSim } });
  return { enqueued: [eventId], alsoFired: [] };
}

/** The effect of a timer claimed at `firedVersion` (the stored timer is now `FIRED`). */
export async function dispatchEffect(timer: Timer, firedVersion: number, deps: TimerDeps, context: FireContext): Promise<DispatchEffect> {
  switch (timer.kind) {
    case "SETTLEMENT_PUBLISH":
      return publishBatch(timer, firedVersion, deps, context);
    case "SETTLEMENT_RECHECK":
      return recheck(timer, firedVersion, deps, context);
    case "NETWORK_TRANSITION":
      return networkTransition(timer, firedVersion, deps, context);
    default:
      return toWorker(timer, firedVersion, deps, context);
  }
}

