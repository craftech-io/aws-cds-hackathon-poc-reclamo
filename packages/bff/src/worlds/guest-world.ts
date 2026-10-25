// A guest world for an invited account (docs/architecture.md §10-§11): `console:invite -- --guest <n>`
// (scripts/console/invite.ts) and the QA driver's `guest.invite` call it after Cognito returned the
// account's `sub`, before anyone can sign in:
//
//   1. pre-registration: `W#<w>#WORLD/META` (`kind`, `template guest`, `origin INVITED`, `REGISTERED`)
//      and the account's `STAFF#` row (`role GUEST`, `cognitoSubKey = SUB#<sub>`), together; a world
//      that exists keeps its row, and a row bound to another `sub` stops everything (CONFLICT);
//   2. `create_world` (worlds/create.ts): `REGISTERED → CREATING → READY`, block by block;
//   3. a world an interrupted run left `CREATING` is finished only with `resume` (`--resume`).
//
// Only `g01..g99` and `gtest` (and QA worlds of the driver): never `gprobe` (nobody signs in there),
// never a self-signup world (those are provisioned by `WorldJanitor`), never `demo`.
import { ToolError, guestOriginOf, worldKindOf } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import { UNLIMITED, type WorldsDeps } from "./deps";
import { createWorld } from "./create";
import { stageWorldsDeps } from "./stage";

/** The guest account the world is pre-registered for. */
export interface GuestWorldStaff {
  /** `stf-guest-NN` (console:invite) or `stf-qa-guest` (QaDriver). */
  readonly staffId: string;
  /** Cognito `sub` returned by AdminCreateUser; the row stores `SUB#<sub>`. */
  readonly sub: string;
  readonly displayName: string;
}

export interface GuestWorldRequest {
  /** `gNN` or `gtest` (console:invite), or a `qa-*` world (QaDriver `guest.invite`). */
  readonly worldId: string;
  readonly staff: GuestWorldStaff;
  /** Finish a world left `CREATING` by an interrupted run instead of refusing it. */
  readonly resume: boolean;
  /** `false`: only step 1 (the QaDriver's `guest.invite({registerOnly})`); the world stays as it is. */
  readonly build?: boolean;
}

export interface GuestWorldResult {
  readonly worldId: string;
  readonly status: "READY" | "REGISTERED" | "CREATING";
}

type GuestWorldDeps = Pick<WorldsDeps, "connector" | "store" | "templates" | "objects" | "anchors" | "keys" | "log" | "now" | "newId">;

/**
 * Fails with `UNAVAILABLE` before the caller has any side effect when the factory cannot run here (its
 * tables, the `Seed` bucket or the keys are not linked: outside `sst shell`, or a stage without them).
 */
export function assertGuestWorldFactory(): void {
  stageWorldsDeps().assertLinked();
}

function guestWorldClass(worldId: string): "INVITED" | "QA" {
  if (worldId === "gprobe") throw new ToolError("FORBIDDEN", "gprobe is a probe target: nobody signs in there", "WORLD_NOT_INVITABLE");
  const origin = guestOriginOf(worldId);
  if (origin === "INVITED") return "INVITED";
  if (origin === undefined && worldKindOf(worldId) === "QA" && worldId.startsWith("qa-")) return "QA";
  throw new ToolError("FORBIDDEN", `${worldId} is not a world an invited guest gets`, "WORLD_NOT_INVITABLE");
}

/** Step 1: the world and its staff row, written once; an existing row must be this account's. */
async function preRegister(deps: GuestWorldDeps, request: GuestWorldRequest, kind: "INVITED" | "QA"): Promise<void> {
  const { worlds } = deps.connector;
  const staffRow = { worldId: request.worldId, staffId: request.staff.staffId, role: "GUEST" as const, displayName: request.staff.displayName, cognitoSubKey: keys.subKey(request.staff.sub), active: true };
  const meta = await worlds.getMeta(request.worldId, { consistent: true });
  if (!meta) {
    try {
      await deps.connector.transact([
        worlds.registerOp({ worldId: request.worldId, kind: kind === "QA" ? "QA" : "GUEST", template: "guest", epoch: 1, status: "REGISTERED", ...(kind === "INVITED" ? { origin: "INVITED" as const } : {}) }),
        worlds.putStaffOp(staffRow),
      ]);
      return;
    } catch (error) {
      if (!isConflict(error)) throw error; // a concurrent run registered it: check its row below
    }
  }
  const existing = await worlds.getStaff(request.worldId, request.staff.staffId);
  if (!existing) {
    await worlds.putStaff(staffRow);
    return;
  }
  if (existing.cognitoSubKey !== staffRow.cognitoSubKey || existing.role !== "GUEST") {
    throw new ToolError("CONFLICT", `${request.staff.staffId} of ${request.worldId} belongs to another account`, "STAFF_MISMATCH");
  }
}

/** Pre-registers the guest world and builds it until `READY` (see the header). */
export async function createGuestWorld(request: GuestWorldRequest, deps: GuestWorldDeps = stageWorldsDeps()): Promise<GuestWorldResult> {
  const kind = guestWorldClass(request.worldId);
  await preRegister(deps, request, kind);
  const meta = await deps.connector.worlds.getMeta(request.worldId, { consistent: true });
  if (meta?.status === "READY") return { worldId: request.worldId, status: "READY" };
  if (request.build === false && (meta?.status === "REGISTERED" || meta?.status === "CREATING")) return { worldId: request.worldId, status: meta.status };
  if (meta?.status === "CREATING" && !request.resume) {
    throw new ToolError("CONFLICT", `${request.worldId} was left half-built by an interrupted run: run it again with --resume`, "WORLD_CREATING");
  }
  if (meta?.status !== "REGISTERED" && meta?.status !== "CREATING") throw new ToolError("CONFLICT", `${request.worldId} is ${meta?.status ?? "missing"}`, "WORLD_NOT_CREATABLE");
  const result = await createWorld(deps, { worldId: request.worldId, template: "guest", budget: UNLIMITED });
  if (result.status !== "READY") throw new ToolError("UNAVAILABLE", `${request.worldId} did not finish`, "WORLD_CREATING");
  return { worldId: request.worldId, status: "READY" };
}
