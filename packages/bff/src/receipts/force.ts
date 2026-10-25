// `receipt.forceFallback` of the QA driver (docs/tool-catalog.md): a QA world can ask `read_receipt` to
// skip Bedrock (a `ThrottlingException` that ran out of retries) and read with the deterministic parser
// only. The QA driver writes the switch as `Runtime/W#<qa>#IDEMP#RECEIPTFORCE#world`; outside the QA
// worlds the switch is never read, so no other world can turn Bedrock off.
import { worldKindOf } from "@reclamo/shared";
import type { Connector } from "../connector/port";

export const RECEIPT_FORCE_SOURCE = "RECEIPTFORCE";
export const RECEIPT_FORCE_ID = "world";

/** Whether `read_receipt` of this world skips Bedrock. */
export async function receiptFallbackForced(connector: Pick<Connector, "claims">, worldId: string): Promise<boolean> {
  if (worldKindOf(worldId) !== "QA") return false;
  return (await connector.claims.getIdempotency(worldId, RECEIPT_FORCE_SOURCE, RECEIPT_FORCE_ID)) !== undefined;
}
