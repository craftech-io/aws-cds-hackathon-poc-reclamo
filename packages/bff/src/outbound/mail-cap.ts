// The daily email cap of a self-signup world (docs/architecture-guests.md §11, ADR-0020, FL-125):
// `W#<w>#MAILCAP#<realDay>`, 40 product emails per real day, counted by the gate right before the
// transport (after every check, so a refused or blocked email never spends it). The bucket is on the
// REAL clock: "+1 h" of the world's clock never opens a new one. Invited guest worlds, `demo`, QA and
// simulated-load worlds are not counted here (their SES rate cap lives in the SES client).
import { isSignupWorld } from "../auth/guest-identity";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import type { Connector } from "../connector/port";
import { realDayStamp } from "../connector/repos/caps";
import { cond } from "../connector/store";
import { expiry } from "../connector/ttl";

export const MAIL_CAP_PER_DAY = 40;

/** Counts one email of the world's real day; `false` when the cap was already reached (nothing counted). */
export async function takeMailCap(data: Pick<Connector, "write">, worldId: string, realNow: Date): Promise<boolean> {
  if (!isSignupWorld(worldId)) return true;
  try {
    await data.write({
      kind: "update",
      table: "Runtime",
      key: keys.runtime(worldId, "MAILCAP", realDayStamp(realNow)),
      condition: cond.or(cond.notExists("count"), cond.lt("count", MAIL_CAP_PER_DAY)),
      update: { add: { count: 1 }, set: { entity: "CapCounter", worldId, updatedAt: realNow.toISOString(), ...expiry("cap", worldId, realNow) } },
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}
