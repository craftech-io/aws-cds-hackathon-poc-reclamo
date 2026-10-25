// The `FOLLOW_UP` timer of a complaint (docs/architecture.md §10): due at the asked instant moved into
// the world's contact hours, one per complaint and asked instant (a conditional put on a derived id). A
// schedule is created only when the world runs; the clock dispatches the timer either way. Its turn is a
// `TRANSFER_STATUS_CHANGED` with `followUp` (worker/events.ts).
import { ToolError } from "@reclamo/shared";
import { contactSchedule, nextOpening } from "../../channel-policy/hours";
import type { MilestoneScheduler } from "../../complaints/deps";
import { complaintOwnerKey, isoAr, loadHolidays } from "../../complaints/sla";
import { isConflict } from "../../connector/errors";
import type { Complaint } from "../../domain/complaint";
import { sha256Hex } from "../../lib/crypto";
import type { ToolContext } from "../common/context";
import { settingsOf } from "../actions/ports";

/** The follow-up timer of a complaint at an asked instant (one per complaint and instant). */
export function followUpTimerId(complaintId: string, askedAtSim: string): string {
  return `${complaintId}-FOLLOW_UP-${sha256Hex(askedAtSim).slice(0, 12)}`;
}

export async function scheduleFollowUp(ctx: ToolContext<unknown>, complaint: Complaint, askedAtSim: string, milestones: MilestoneScheduler | undefined): Promise<string> {
  const asked = new Date(askedAtSim);
  if (asked.getTime() <= Date.parse(ctx.session.eventAtSim)) throw new ToolError("INVALID", "followUpAtSim must be after the current simulated instant", "FOLLOW_UP_IN_PAST");
  const settings = await settingsOf(ctx);
  const dueAtSim = isoAr(nextOpening(asked, contactSchedule(settings.contactHours, await loadHolidays(ctx.connector))));
  const timerId = followUpTimerId(complaint.complaintId, askedAtSim);
  try {
    await ctx.connector.write(
      ctx.connector.timers.putOp({
        worldId: ctx.session.worldId,
        kind: "FOLLOW_UP",
        timerId,
        dueAtSim,
        seq: 0,
        status: "SCHEDULED",
        epoch: complaint.epoch,
        ownerKey: complaintOwnerKey(complaint.complaintId),
        payload: { complaintId: complaint.complaintId, complaintNumber: complaint.complaintNumber, askedAtSim },
      }),
    );
  } catch (error) {
    if (!isConflict(error)) throw error;
    return dueAtSim;
  }
  try {
    await milestones?.schedule(ctx.session.worldId, [{ kind: "FOLLOW_UP", timerId }]);
  } catch (error) {
    // The timer is in the table: the clock dispatches it, and the next resynchronization of the world's
    // schedules (any dispatch or clock change) creates its schedule.
    ctx.log.warn("tool.follow_up_schedule_failed", { error });
  }
  return dueAtSim;
}
