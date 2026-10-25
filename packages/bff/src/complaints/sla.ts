// The regulatory clock of a complaint (docs/architecture.md §8.4, docs/design-brief.md §6): the written
// answer is due by 23:59:59 of the 10th business day after filing, with three milestones, one timer
// each (`Timers/W#<w>#TIMER#SLA#<complaintId>-<milestone>`), created in the same transaction that
// registers the complaint. The written answer (or a withdrawal) cancels them: each `SCHEDULED` timer
// goes to `CANCELLED` with `version + 1` in the same transaction as the transition, and the caller's
// `MilestoneScheduler` deletes their schedules after the commit. Answered, the complaint gets an
// `AUTO_CLOSE` timer five business days later. Holidays come from `Reference/HOLIDAY#AR`.
import { z } from "zod";
import { CalendarDate, type SlaMilestone, type SlaState } from "@reclamo/shared";
import type { Timer } from "../domain/timer";
import type { NewOf } from "../connector/codec";
import type { Connector } from "../connector/port";
import type { WriteOp } from "../connector/store";
import { AR_UTC_OFFSET, MILESTONE_SCHEDULE, deadline, localDateAr, milestones, nthBusinessDay } from "../services/business-days";

/** Order of the milestones, which is also their `seq` (stable tie-break between timers). */
export const MILESTONE_ORDER: readonly SlaMilestone[] = ["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"];

/** Business days after `ANSWERED` before a complaint closes on its own. */
export const AUTO_CLOSE_BUSINESS_DAYS = 5;

const OFFSET_MS = -3 * 60 * 60 * 1000;
const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** An instant in Argentine local time with its offset (`2026-10-22T23:59:59-03:00`). */
export function isoAr(instant: Date): string {
  const local = new Date(instant.getTime() + OFFSET_MS);
  return `${local.toISOString().slice(0, 19)}${AR_UTC_OFFSET}`;
}

/** How a deadline reads to the customer: "jueves 22/10". */
export function deadlineText(instant: string | Date): string {
  const local = new Date(new Date(instant).getTime() + OFFSET_MS);
  return `${WEEKDAYS_ES[local.getUTCDay()] ?? "domingo"} ${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}`;
}

export interface SlaPlan {
  readonly deadlineSim: string;
  readonly milestones: readonly { readonly milestone: SlaMilestone; readonly dueAtSim: string }[];
}

/** Deadline and milestones of a complaint filed at `filedAtSim` (simulated). */
export function slaPlan(filedAtSim: string, holidays: Iterable<string>): SlaPlan {
  const filed = new Date(filedAtSim);
  const list = [...holidays];
  const at = milestones(filed, list);
  return { deadlineSim: isoAr(deadline(filed, list)), milestones: MILESTONE_ORDER.map((milestone) => ({ milestone, dueAtSim: isoAr(at[milestone]) })) };
}

export function milestoneTimerId(complaintId: string, milestone: SlaMilestone): string {
  return `${complaintId}-${milestone}`;
}

/** `CMP#<complaintId>`: the owner of every timer of a complaint (index `ByOwner`). */
export function complaintOwnerKey(complaintId: string): string {
  return `CMP#${complaintId}`;
}

/** The three `SCHEDULED` milestone timers of a new complaint, for the numbering transaction. */
export function milestoneTimers(input: { worldId: string; epoch: number; complaintId: string; complaintNumber: string; plan: SlaPlan }): NewOf<typeof Timer>[] {
  return input.plan.milestones.map(({ milestone, dueAtSim }, index) => ({
    worldId: input.worldId,
    kind: "SLA",
    timerId: milestoneTimerId(input.complaintId, milestone),
    dueAtSim,
    seq: index,
    status: "SCHEDULED",
    epoch: input.epoch,
    ownerKey: complaintOwnerKey(input.complaintId),
    payload: { milestone, complaintId: input.complaintId, complaintNumber: input.complaintNumber, deadlineSim: input.plan.deadlineSim },
  }));
}

/** When an answered complaint may close: `AUTO_CLOSE_BUSINESS_DAYS` after the answer, same local time. */
export function autoCloseAt(answeredAtSim: string, holidays: Iterable<string>): string {
  const answered = new Date(answeredAtSim);
  const time = isoAr(answered).slice(11, 19);
  return isoAr(nthBusinessDay(answered, AUTO_CLOSE_BUSINESS_DAYS, time, holidays));
}

/** The `AUTO_CLOSE` timer of the `n`-th answer of a complaint (a bounced answer can be answered again). */
export function autoCloseTimer(input: { worldId: string; epoch: number; complaintId: string; answeredAtSim: string; answerIndex: number; holidays: Iterable<string> }): NewOf<typeof Timer> {
  return {
    worldId: input.worldId,
    kind: "AUTO_CLOSE",
    timerId: `${input.complaintId}-AUTO_CLOSE-${input.answerIndex}`,
    dueAtSim: autoCloseAt(input.answeredAtSim, input.holidays),
    seq: MILESTONE_ORDER.length,
    status: "SCHEDULED",
    epoch: input.epoch,
    ownerKey: complaintOwnerKey(input.complaintId),
    payload: { complaintId: input.complaintId },
  };
}

export interface CancelPlan {
  readonly ops: WriteOp[];
  /** Schedules the cancelled timers had (the scheduler deletes them after the commit). */
  readonly scheduleNames: string[];
  readonly timerIds: string[];
}

/** `SCHEDULED → CANCELLED` (`version + 1`, same epoch) for the complaint's timers of these kinds. */
export async function cancelTimersPlan(connector: Connector, worldId: string, complaintId: string, kinds: readonly Timer["kind"][], reason: string): Promise<CancelPlan> {
  const timers = await connector.timers.listByOwner(worldId, complaintOwnerKey(complaintId));
  const open = timers.filter((timer) => timer.status === "SCHEDULED" && kinds.includes(timer.kind));
  return {
    ops: open.map((timer) =>
      connector.timers.transitionOp({ worldId, kind: timer.kind, timerId: timer.timerId, version: timer.version, from: ["SCHEDULED"], to: "CANCELLED", epoch: timer.epoch, reason }),
    ),
    scheduleNames: open.flatMap((timer) => (timer.scheduleName ? [timer.scheduleName] : [])),
    timerIds: open.map((timer) => timer.timerId),
  };
}

/** `cancel_milestones`: the three SLA timers of a complaint, when it is answered or withdrawn. */
export function cancelMilestonesPlan(connector: Connector, worldId: string, complaintId: string, reason: "ANSWERED" | "WITHDRAWN"): Promise<CancelPlan> {
  return cancelTimersPlan(connector, worldId, complaintId, ["SLA"], reason);
}

/** Where a complaint stands against its deadline at `simNow` (the milestones also set it as they fire). */
export function slaStateAt(input: { filedAtSim: string; deadlineSim: string; answeredAtSim?: string; simNow: string | Date; holidays: Iterable<string> }): SlaState {
  // An answered complaint stopped its clock when the answer went out.
  const now = input.answeredAtSim ? Date.parse(input.answeredAtSim) : new Date(input.simNow).getTime();
  if (input.answeredAtSim) return now > Date.parse(input.deadlineSim) ? "OVERDUE" : "ON_TIME";
  if (now > Date.parse(input.deadlineSim)) return "OVERDUE";
  const { businessDay, time } = MILESTONE_SCHEDULE.SUPERVISOR_ESCALATION;
  const escalation = nthBusinessDay(new Date(input.filedAtSim), businessDay, time, input.holidays);
  return now >= escalation.getTime() ? "AT_RISK" : "ON_TIME";
}

/** A holiday of `Reference/HOLIDAY#AR` (docs/seed-spec.md §11): the seed writes its `date`. */
export const HolidayRecord = z.object({ date: CalendarDate });

/** The Argentine holidays the deadlines count with, from `Reference`. */
export async function loadHolidays(connector: Connector): Promise<string[]> {
  const records = await connector.reference.list(HolidayRecord, "HOLIDAY", "AR");
  return records.map((record) => record.date).sort();
}

/** The simulated year of an instant in Argentina (the complaint number's year). */
export function simYearAr(instant: string | Date): number {
  return Number(localDateAr(new Date(instant)).slice(0, 4));
}
