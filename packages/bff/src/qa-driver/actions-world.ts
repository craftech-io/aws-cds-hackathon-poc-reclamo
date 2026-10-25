// World actions of the QaDriver (docs/tool-catalog.md): `world.create`, `world.destroy`, `guest.invite`
// and `guest.expireNow`. The world factory, the destruction and the expiry are the code `WorldJanitor`
// and `console:invite` run; the driver only runs them in steps of PROBE_BUDGET_MS.
import { StaffRole, ToolError } from "@reclamo/shared";
import { requestAndStartReset } from "../worlds/reset";
import { createGuestWorld } from "../worlds/guest-world";
import { QA_REASON } from "./contract";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";
import { createQaWorld, destroyQaWorld } from "./world-build";

function worldOf(ctx: ActionContext): string {
  if (ctx.worldId === undefined) throw new ToolError("INVALID", "this action needs its world");
  return ctx.worldId;
}

/** `qa-<runId>-<scenario>-<role>`: the one user per role of a QA world (never `runId` and role alone). */
export function qaUsername(worldId: string, role: StaffRole): string {
  return `${worldId}-${role.toLowerCase()}`;
}

/** `stf-qa-<role>`: the staff row of that user in its world. */
export function qaStaffId(role: StaffRole): string {
  return `stf-qa-${role.toLowerCase()}`;
}

/**
 * The `sub` of the world's user of `role`, created once; a user the janitor deleted is created again,
 * and one whose staff row is missing (an interrupted first call) is replaced.
 */
export async function ensureQaUser(ctx: ActionContext, worldId: string, role: StaffRole): Promise<string> {
  const cognito = ctx.ports.cognito();
  const username = qaUsername(worldId, role);
  const created = await cognito.createUser({ username, worldId, group: role });
  if (created !== "EXISTS") return created.sub;
  const staff = await ctx.ports.data.worlds.getStaff(worldId, qaStaffId(role));
  if (staff !== undefined) return staff.cognitoSubKey.slice("SUB#".length);
  await cognito.deleteUser(username);
  const again = await cognito.createUser({ username, worldId, group: role });
  if (again === "EXISTS") throw new ToolError("CONFLICT", "the QA user could not be created again", "QA_USER_EXISTS");
  return again.sub;
}

export async function worldCreate(input: QaInput<"world.create">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  return createQaWorld(
    ctx.ports,
    { runId: input.runId, worldId, template: input.template, personas: input.personas, history: input.history, ...(input.settings ? { settings: input.settings } : {}) },
    ctx.startedAt,
  );
}

/** Destroys by steps; once destroyed, the world's QA users go too (best effort: the hourly pass sweeps the rest). */
export async function worldDestroy(_input: QaInput<"world.destroy">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const result = await destroyQaWorld(ctx.ports, worldId, ctx.startedAt);
  if (result.state !== "DESTROYED") return result;
  let usersDeleted = 0;
  for (const role of StaffRole.options) {
    try {
      await ctx.ports.cognito().deleteUser(qaUsername(worldId, role));
      usersDeleted += 1;
    } catch (error) {
      ctx.log.warn("qa_driver.user_cleanup_failed", { role, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { ...result, usersDeleted };
}

/**
 * The same code as `console:invite -- --guest` (worlds/guest-world.ts): the account `qa-…-guest` with
 * `custom:worldId` and group `GUEST`, the pre-registration and `create_world('guest')` until `READY`.
 * Then `auth.session({sessionKey, role: GUEST, flow: SRP})` signs it in (SC-22/8). With `registerOnly` the
 * world stays `REGISTERED`: a login before it is built is refused `WORLD_NOT_READY` (SC-22/8).
 */
export async function guestInvite(input: QaInput<"guest.invite">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const sub = await ensureQaUser(ctx, worldId, "GUEST");
  const result = await createGuestWorld({ worldId, staff: { staffId: qaStaffId("GUEST"), sub, displayName: "Invitado QA" }, resume: true, build: input.registerOnly !== true }, ctx.ports.worlds());
  return { sessionKey: "guest", status: result.status };
}

/**
 * `WorldJanitor`'s expiry of a runner sign-up world (`qa-<runId>-su<n>`), same phases: the request and
 * the asynchronous invocation on the first call, then the world's status as a probe until `EXPIRED`.
 */
export async function guestExpireNow(_input: QaInput<"guest.expireNow">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const deps = ctx.ports.worlds();
  const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
  if (meta === undefined) throw new ToolError("NOT_FOUND", `${worldId} does not exist`, "WORLD_MISSING");
  if (meta.status === "EXPIRED") return { state: "EXPIRED" };
  if (meta.status === "READY") {
    const requested = await requestAndStartReset(deps, { worldId, actor: "QA", kind: "EXPIRE", reason: "QA_EXPIRE_NOW" });
    return { state: "EXPIRING", requestId: requested.requestId };
  }
  if (meta.status === "EXPIRING") return { state: "EXPIRING", phase: meta.reset?.phase ?? null };
  throw new ToolError("CONFLICT", `${worldId} is ${meta.status}`, QA_REASON.QA_FENCE);
}
