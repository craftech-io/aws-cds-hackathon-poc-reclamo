// Where a world's media objects live in `Media` (docs/architecture.md §6), without any client: the
// infra tests check the Bff's object grants against these same keys.
import { worldKindOf } from "@reclamo/shared";

/**
 * Root of a world's objects (docs/architecture.md §6): `W/<worldId>/` for `demo`, guest and `sim-*`
 * worlds, `qa/<runId>/<worldId>/` for `qa-*` (and `qa-live-*`), `qa/qamin/` for `qamin`.
 */
export function worldStorageRoot(worldId: string): string {
  if (worldId === "qamin") return "qa/qamin/";
  if (worldKindOf(worldId) === "QA") {
    const runId = worldId.replace(/^qa-/, "").replace(/^live-/, "").split("-")[0] ?? "";
    return `qa/${runId}/${worldId}/`;
  }
  return `W/${worldId}/`;
}

/** Where a world's simulator uploads live: `up/<worldId>/` (QA worlds: `<root>up/`, under the 2-day `qa/` lifecycle). */
export function uploadPrefixOf(worldId: string): string {
  return worldKindOf(worldId) === "QA" ? `${worldStorageRoot(worldId)}up/` : `up/${worldId}/`;
}
