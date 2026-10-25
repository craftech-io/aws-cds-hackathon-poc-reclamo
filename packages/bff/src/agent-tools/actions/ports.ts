// The outside world of the `actions` target: the core and network clients and what complaints/ needs
// to write (the register chain key, the anchor requester). `ToolActions` has no outbound pipeline
// (docs/architecture.md §9.2): nothing here sends a message; what the customer reads about an action
// goes out through a tool that has the gate. The deployed entry (handler.ts) builds the ports from what
// SST links into the Lambda, once per container and on first use; the tests and the local flows pass
// the in-process mocks and the memory connector.
import type { CoreClient } from "../../core/client";
import type { ComplaintsDeps } from "../../complaints/deps";
import type { WorldSettings } from "../../domain/world";
import type { Logger } from "../../lib/log";
import type { NetworkClient } from "../../networks/client";
import { ToolError } from "@reclamo/shared";
import type { ToolContext } from "../common/context";
import { NO_OPEN_COMPLAINT } from "../common/fences";

export interface ActionPorts {
  readonly core: () => CoreClient;
  readonly networks: () => NetworkClient;
  /** complaints/ dependencies bound to the call's logger, over the same connector as the tool. */
  readonly complaints: (log: Logger) => ComplaintsDeps;
}

/** The world's settings (caps, reference rate); a world without them cannot act. */
export async function settingsOf(ctx: Pick<ToolContext<unknown>, "connector" | "session">): Promise<WorldSettings> {
  const settings = await ctx.connector.worlds.getSettings(ctx.session.worldId);
  if (settings === undefined) throw new ToolError("UNAVAILABLE", "the world has no settings yet");
  return settings;
}

/** The complaint the `LAM-COMPLAINT-REQUIRED` fence resolved (every tool that calls this is **Rc**). */
export function requiredComplaint<C extends { readonly complaint?: unknown }>(ctx: C): NonNullable<C["complaint"]> {
  if (ctx.complaint === undefined || ctx.complaint === null) throw new ToolError("COMPLAINT_REQUIRED", NO_OPEN_COMPLAINT);
  return ctx.complaint as NonNullable<C["complaint"]>;
}
