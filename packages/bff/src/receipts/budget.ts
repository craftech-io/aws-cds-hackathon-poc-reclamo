// What is checked before every image read that calls Bedrock (docs/architecture-integrations.md §7,
// step 1; docs/architecture.md §13; docs/architecture-guests.md §11): the agent kill switch (global
// `KILL#AGENT` and the world's `W#<w>#KILL`), the image reads of the conversation and of the world per
// REAL day, and the global pool. All on the real clock: the guest drives the simulated one, so "+1 day"
// never opens a new bucket. A refusal reads nothing: the tool answers `AGENT_KILLED` or `TURN_CAP`.
//
//   per conversation  `W#<w>#IMGCAP#<customerId>#<realDay>`  10
//   per world         `W#<w>#IMGCAP#ALL#<realDay>`           60 (invited guest worlds), 20 (self-signup `gs-*`)
//   global            `GLOBALCAP#PUBLIC#…` (turns and image reads of demo and invited guests, 300/h, 1,500/day),
//                     `GLOBALCAP#QA#…` (500/h, 1,500/day), and the self-signup pool's own image cap
//                     (`GLOBALCAP#SIGNUPIMG#<realDay>`, 200/day) through the guests module's counter
import { guestOriginOf, worldKindOf } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { Logger } from "../lib/log";

export const IMAGE_READ_CAPS = {
  perConversationPerDay: 10,
  invitedGuestWorldPerDay: 60,
  signupWorldPerDay: 20,
  public: { perHour: 300, perDay: 1_500 },
  qa: { perHour: 500, perDay: 1_500 },
} as const;

/** The pseudo-customer of the world-wide image bucket (`IMGCAP#ALL#…`); no customer id has this shape. */
export const WORLD_IMAGE_BUCKET = "ALL";

export type BudgetVerdict = { readonly ok: true } | { readonly ok: false; readonly code: "AGENT_KILLED" | "TURN_CAP"; readonly reason: string };

export interface ReadBudget {
  admit(input: { readonly worldId: string; readonly customerId: string }): Promise<BudgetVerdict>;
}

export interface ConnectorBudgetDeps {
  readonly connector: Pick<Connector, "runtime" | "caps">;
  /** Real clock. */
  readonly now: () => Date;
  /**
   * One more image read of the self-signup pool (`GLOBALCAP#SIGNUPIMG#<realDay>`, guests module);
   * `false` once the pool reached its cap. Required: a `gs-*` read is never left unbounded.
   */
  readonly signupImagePool: (at: Date) => Promise<boolean>;
  readonly log: Logger;
}

function worldDailyCap(worldId: string): number | undefined {
  const origin = guestOriginOf(worldId);
  if (origin === "SIGNUP") return IMAGE_READ_CAPS.signupWorldPerDay;
  if (origin === "INVITED") return IMAGE_READ_CAPS.invitedGuestWorldPerDay;
  return undefined;
}

export function connectorReadBudget(deps: ConnectorBudgetDeps): ReadBudget {
  const refuse = (code: "AGENT_KILLED" | "TURN_CAP", reason: string, worldId: string): BudgetVerdict => {
    deps.log.warn("receipts.read_refused", { metric: code === "AGENT_KILLED" ? "AgentKilled" : "GlobalCapHits", reason, worldId });
    return { ok: false, code, reason };
  };
  return {
    async admit({ worldId, customerId }) {
      if (await deps.connector.runtime.isAgentKilled(worldId)) return refuse("AGENT_KILLED", "KILL_SWITCH", worldId);
      const at = deps.now();
      const conversation = await deps.connector.caps.increment({ kind: "IMGCAP", worldId, customerId, at }, IMAGE_READ_CAPS.perConversationPerDay);
      if (!conversation.allowed) return refuse("TURN_CAP", "IMAGE_READS_CONVERSATION", worldId);
      const worldCap = worldDailyCap(worldId);
      if (worldCap !== undefined) {
        const world = await deps.connector.caps.increment({ kind: "IMGCAP", worldId, customerId: WORLD_IMAGE_BUCKET, at }, worldCap);
        if (!world.allowed) return refuse("TURN_CAP", "IMAGE_READS_WORLD", worldId);
      }
      if (guestOriginOf(worldId) === "SIGNUP") {
        return (await deps.signupImagePool(at)) ? { ok: true } : refuse("TURN_CAP", "GLOBAL_SIGNUP_IMAGES", worldId);
      }
      const kind = worldKindOf(worldId);
      const pool = kind === "QA" || kind === "SIM" ? "QA" : "PUBLIC";
      const limits = pool === "QA" ? IMAGE_READ_CAPS.qa : IMAGE_READ_CAPS.public;
      const hour = await deps.connector.caps.increment({ kind: "GLOBALCAP", pool, window: "HOUR", at }, limits.perHour);
      if (!hour.allowed) return refuse("TURN_CAP", `GLOBAL_${pool}_HOUR`, worldId);
      const day = await deps.connector.caps.increment({ kind: "GLOBALCAP", pool, window: "DAY", at }, limits.perDay);
      if (!day.allowed) return refuse("TURN_CAP", `GLOBAL_${pool}_DAY`, worldId);
      return { ok: true };
    },
  };
}
