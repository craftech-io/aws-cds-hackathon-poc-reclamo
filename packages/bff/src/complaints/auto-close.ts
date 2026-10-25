// The automatic closure of an answered complaint (docs/flows-catalog.md FL-083): `AUTO_CLOSE` fires
// five business days after the written answer, and a message of the customer in the meantime moves it
// to five business days after that message, so a complaint never closes while the customer is still
// talking about it. Only a later instant moves the timer (a redelivered message changes nothing); the
// timer keeps its id and its version goes up, so a schedule left over from before fires a stale
// version, which the dispatcher discards. The world's schedules are resynchronized afterwards.
import { isConflict } from "../connector/errors";
import type { ComplaintsDeps } from "./deps";
import { autoCloseAt, complaintOwnerKey, loadHolidays } from "./sla";

export interface DeferAutoCloseInput {
  readonly worldId: string;
  readonly customerId: string;
  /** The simulated instant of the customer's message. */
  readonly atSim: string;
}

/** Moves the `AUTO_CLOSE` of every `ANSWERED` complaint of the customer; returns how many moved. */
export async function deferAutoClose(deps: ComplaintsDeps, input: DeferAutoCloseInput): Promise<number> {
  const { connector } = deps;
  const answered = (await connector.complaints.listByCustomer(input.worldId, input.customerId)).filter((complaint) => complaint.status === "ANSWERED");
  if (answered.length === 0) return 0;
  const holidays = await loadHolidays(connector);
  const dueAtSim = autoCloseAt(input.atSim, holidays);
  const moved: { kind: string; timerId: string }[] = [];
  for (const complaint of answered) {
    const timers = await connector.timers.listByOwner(input.worldId, complaintOwnerKey(complaint.complaintId));
    for (const timer of timers.filter((candidate) => candidate.kind === "AUTO_CLOSE" && candidate.status === "SCHEDULED")) {
      if (Date.parse(dueAtSim) <= Date.parse(timer.dueAtSim)) continue;
      try {
        await connector.write(connector.timers.rescheduleOp({ worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId, version: timer.version, due: { atSim: dueAtSim, seq: timer.seq } }));
        moved.push({ kind: timer.kind, timerId: timer.timerId });
      } catch (error) {
        // Fired or moved by someone else meanwhile: what it is now stands.
        if (!isConflict(error)) throw error;
      }
    }
  }
  if (moved.length > 0) await deps.milestones?.schedule(input.worldId, moved);
  return moved.length;
}
