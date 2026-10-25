// `turn.forceFailure` and `turn.forceSilence` of the QaDriver (docs/tool-catalog.md, FL-107): the next
// turn of one QA conversation fails as if the Harness had timed out (`FAILURE`), or closes without
// invoking the Harness and without any outbound (`NO_OUTBOUND`), so `SC-19` proves the fallback and the
// obligations without waiting for the model to get distracted. `SKIP_ANSWER` is the tools' business
// (`answer_complaint_in_writing` answers `UNAVAILABLE` in that turn) and is left for them.
//
// The order lives in `Runtime/W#<qa>#IDEMP#TURNFORCE#<customerId>` (the QaDriver writes only `W#qa-*`) and
// is taken once by a conditional delete. Any other world never reads it.
import { z } from "zod";
import { worldKindOf } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import { cond } from "../connector/store";

export const FORCE_SOURCE = "TURNFORCE";

export const ForcedTurnMode = z.enum(["FAILURE", "NO_OUTBOUND", "SKIP_ANSWER"]);
export type ForcedTurnMode = z.infer<typeof ForcedTurnMode>;

type ForceData = Pick<Connector, "claims" | "write">;

/** The QaDriver's side: the next turn of this QA conversation runs in `mode`. */
export async function forceNextTurn(data: ForceData, worldId: string, customerId: string, mode: ForcedTurnMode): Promise<void> {
  if (worldKindOf(worldId) !== "QA") throw new RangeError("a turn is forced only in a QA world");
  await data.claims.claimOnce(worldId, FORCE_SOURCE, customerId, { mode });
}

/** The worker's side: takes the order of this conversation once; `undefined` when there is none. */
export async function takeForcedTurn(data: ForceData, worldId: string, customerId: string): Promise<ForcedTurnMode | undefined> {
  if (worldKindOf(worldId) !== "QA") return undefined;
  const order = await data.claims.getIdempotency(worldId, FORCE_SOURCE, customerId);
  if (order === undefined) return undefined;
  const mode = ForcedTurnMode.safeParse(order.result?.["mode"]);
  try {
    await data.write({ kind: "delete", table: "Runtime", key: keys.runtime(worldId, "IDEMP", FORCE_SOURCE, customerId), condition: cond.present() });
  } catch (error) {
    // Another delivery took it first: this turn runs normally.
    if (isConflict(error)) return undefined;
    throw error;
  }
  return mode.success ? mode.data : undefined;
}
