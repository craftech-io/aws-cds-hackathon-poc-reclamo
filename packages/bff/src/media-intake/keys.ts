// From a `Media` object key to its registry (docs/architecture.md §6). The registry was written under
// the ANNOUNCE key, which is what the code knew before the object existed:
//
//   wa/<w>/<wamid>/<whatever>                     → wa/<w>/<wamid>/   (the service appends the mediaId)
//   up/<w>/<messageId>/<n>.<ext>                  → itself            (simulator upload)
//   W/<w>/sim/… · qa/<run>/<w>/sim/… · qa/qamin/… → itself            (seed copy, QA upload)
//
// Nothing here depends on the shape of a `mediaId`. The world comes from the key's own segments and
// must be a valid world id; anything else (the plan's validation object, a stray key) has no registry.
import { WorldId } from "@reclamo/shared";
import { scanObjectId } from "../connector/repos/scans";

const LIVE = "wa/";

/** The announce key a GuardDuty `objectKey` resolves to. */
export function announceKeyOf(objectKey: string): string {
  if (!objectKey.startsWith(LIVE)) return objectKey;
  const [, worldId = "", wamid = ""] = objectKey.split("/");
  return `${LIVE}${worldId}/${wamid}/`;
}

/** The world an object key belongs to, from its prefix; `undefined` when it names none. */
export function worldOfObjectKey(objectKey: string): string | undefined {
  const parts = objectKey.split("/");
  let candidate: string | undefined;
  if (parts[0] === "wa" || parts[0] === "up" || parts[0] === "W") candidate = parts[1];
  else if (parts[0] === "qa") candidate = parts[1] === "qamin" ? "qamin" : parts[2];
  return candidate !== undefined && WorldId.safeParse(candidate).success ? candidate : undefined;
}

/** `{worldId, announceKey}` of a scanned object, or `undefined` for a key no world announces. */
export function scanTargetOf(objectKey: string): { readonly worldId: string; readonly announceKey: string } | undefined {
  if (objectKey.includes("..") || objectKey.startsWith("quarantine/")) return undefined;
  const worldId = worldOfObjectKey(objectKey);
  return worldId === undefined ? undefined : { worldId, announceKey: announceKeyOf(objectKey) };
}

/** `SCAN#<sha8>` of the quiescence pending of an image (docs/architecture.md §5). */
export function scanPendingId(announceKey: string): string {
  return scanObjectId(announceKey).slice(0, 8);
}

/** The id of the one customer event an image produces (`RECEIPT_RECEIVED` or `MEDIA_REJECTED`). */
export function mediaEventId(announceKey: string): string {
  return `scan-${scanObjectId(announceKey)}`;
}
