// `guest.status` and `guest.requestWorld` (docs/architecture-guests.md §4): what the provisioning
// screen of a guest polls while its world is prepared, and how an expired self-signup world is asked
// for again. The caller is the verified principal (its `sub`, world and session), never the input;
// both answer in any status of a self-signup world (`WORLD_PENDING_PATHS`).
import { ToolError } from "@reclamo/shared";
import type { GuestCaller, GuestWorldService } from "../guests/world-status";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

function services(ctx: WorldContext): GuestWorldService {
  const build = ctx.deps.guestWorld;
  if (!build) throw new ToolError("UNAVAILABLE", "guest world services are not configured");
  return build(ctx.log);
}

function callerOf(ctx: WorldContext): GuestCaller {
  return { sub: ctx.principal.sub, worldId: ctx.principal.worldId, sessionId: ctx.principal.sessionId };
}

export const guestRouter = router({
  status: accessProcedure("guest.status").query(({ ctx }) => services(ctx).status(callerOf(ctx))),
  requestWorld: accessProcedure("guest.requestWorld").mutation(({ ctx }) => services(ctx).requestWorld(callerOf(ctx))),
});
