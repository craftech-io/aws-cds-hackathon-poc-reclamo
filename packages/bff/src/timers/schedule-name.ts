// Names of the EventBridge Scheduler schedules of the timers (docs/architecture.md §10):
//
//   tm-<worldId>-e<epoch>-<base32(sha256(timerKey))[0:16]>      lower case, at most 64 characters
//
// The world id and the epoch stay readable (a QA world starts with `qa-`, so its schedules start with
// `tm-qa-` and the QaDriver's `tm-q*` fence keeps holding); the hash of the full timer key
// (`W#<worldId>#TIMER#<kind>#<timerId>`) tells two timers of the same world apart, and two worlds with
// the same template timers never share a name. `ScheduleDispatch` recomputes the name from the
// input's `timerKey` and `epoch` and discards a fire whose `scheduleArn` (the Scheduler's context
// attribute, never the caller's word) names another schedule (`SCHEDULE_NAME_MISMATCH`).
import { createHash } from "node:crypto";
import { base32 } from "../leads/keys";

/** EventBridge Scheduler's limit on a schedule name. */
export const SCHEDULE_NAME_MAX = 64;

const HASH_CHARS = 16;

/** The context attribute the Scheduler replaces with the ARN of the schedule that fires. */
export const SCHEDULE_ARN_PLACEHOLDER = "<aws.scheduler.schedule-arn>";

/** `arn:aws:scheduler:<region>:<account>:schedule/<group>/<name>` */
const SCHEDULE_ARN = /^arn:aws[a-z-]*:scheduler:[a-z0-9-]+:\d{12}:schedule\/([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,64})$/;

export class ScheduleNameError extends RangeError {
  override readonly name = "ScheduleNameError";
}

/** The schedule of one timer of one epoch of one world. */
export function scheduleNameOf(worldId: string, epoch: number, timerKey: string): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ScheduleNameError(`invalid epoch ${epoch}`);
  if (!/^[a-z0-9-]+$/.test(worldId)) throw new ScheduleNameError("a schedule name needs a lower-case world id");
  if (!timerKey.startsWith(`W#${worldId}#TIMER#`)) throw new ScheduleNameError("the timer key belongs to another world");
  const hash = base32(createHash("sha256").update(timerKey, "utf8").digest()).slice(0, HASH_CHARS);
  const name = `tm-${worldId}-e${epoch}-${hash}`;
  if (name.length > SCHEDULE_NAME_MAX) throw new ScheduleNameError(`schedule name of world ${worldId} is longer than ${SCHEDULE_NAME_MAX}`);
  return name;
}

/** Group and name of a schedule ARN, or `undefined` for anything that is not one. */
export function parseScheduleArn(arn: string): { readonly group: string; readonly name: string } | undefined {
  const match = SCHEDULE_ARN.exec(arn);
  if (!match?.[1] || !match[2]) return undefined;
  return { group: match[1], name: match[2] };
}

/** True when the ARN is the schedule of this timer of this epoch (and, when given, of this group). */
export function arnMatchesTimer(arn: string, expected: { readonly worldId: string; readonly epoch: number; readonly timerKey: string; readonly group?: string }): boolean {
  const parsed = parseScheduleArn(arn);
  if (!parsed) return false;
  if (expected.group !== undefined && parsed.group !== expected.group) return false;
  try {
    return parsed.name === scheduleNameOf(expected.worldId, expected.epoch, expected.timerKey);
  } catch {
    return false;
  }
}

/** `at(yyyy-mm-ddThh:mm:ss)` in UTC; a fraction of a second rounds up, so a schedule never fires early. */
export function atExpression(at: Date): string {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new ScheduleNameError("a schedule needs a valid instant");
  const second = Math.ceil(ms / 1000) * 1000;
  return `at(${new Date(second).toISOString().slice(0, 19)})`;
}
