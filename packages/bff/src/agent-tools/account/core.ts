// The lender core as the identity, account and investigation tools see it: the one core client
// (core/client.ts, timeouts, retries and the contract's zod on both sides), called with the session's
// world, the simulated instant of the event that opened the turn (`X-Sim-Now`, ADR-0011) and the
// turn's correlation id. The client is resolved on the first call that needs it, so building a target
// never reads `Resource`.
import type { CoreCallContext, CoreClient } from "../../core/client";
import { linkedCoreClient } from "../../core/linked";
import type { ToolContext } from "../common/context";

/** What the tools call on the core (local flows and tests pass the in-process mock behind the same client). */
export type CoreReader = Pick<CoreClient, "call">;

export type CorePort = () => CoreReader;

export const productionCore: CorePort = linkedCoreClient;

/** World, simulated now and correlation id of a tool call. */
export function coreContextOf(ctx: Pick<ToolContext<unknown>, "session" | "correlationId">): CoreCallContext {
  return { worldId: ctx.session.worldId, simNow: ctx.session.eventAtSim, correlationId: ctx.correlationId };
}
