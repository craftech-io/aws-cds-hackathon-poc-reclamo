// The contract between the self-signup and the world factory (docs/architecture-guests.md §5). The
// sign-up never builds a world: it leaves the world `REGISTERED` in the sparse `GuestIndex` queue,
// opens a ticket `Runtime/W#<w>#PROVISIONREQ#<requestId>` and asks `WorldJanitor` to act, with only
// `{kind: WORLD_CREATE, worldId, requestId}`. The factory (WP-34) claims the ticket, respects the
// cap of active worlds and builds `REGISTERED → CREATING → READY`; until it exists the ticket waits
// and the console shows "Estamos preparando tu mundo". An expired world comes back the same way.
import { z } from "zod";
import { WorldId } from "@reclamo/shared";
import { type RepoContext, encode } from "../connector/codec";
import { keys } from "../connector/keys";
import type { StoredItem, WriteOp } from "../connector/store";
import { cond } from "../connector/store";
import { expiry } from "../connector/ttl";
import { LEADS_TTL_SECONDS, expiresAt } from "../leads/limits";
import { guestQueueAttributes } from "../worlds/meta";

/** What `WorldJanitor` receives for a self-signup world (it re-reads the ticket, never trusts more). */
export const WorldCreateRequest = z.object({ kind: z.literal("WORLD_CREATE"), worldId: WorldId, requestId: z.string().regex(/^[0-9A-Z]{26}$/) }).strict();
export type WorldCreateRequest = z.infer<typeof WorldCreateRequest>;

/** What `LeadNotifier` receives: the lead's `sub` and nothing else. */
export const LeadNoticeRequest = z.object({ leadId: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, "a Cognito sub") }).strict();
export type LeadNoticeRequest = z.infer<typeof LeadNoticeRequest>;

export const ProvisionTicketStatus = z.enum(["OPEN", "CLAIMED", "DONE"]);

/** The asynchronous invocations after a registration (`InvocationType: Event`). */
export interface ProvisionInvoker {
  createWorld(request: WorldCreateRequest): Promise<void>;
  notifyLead(request: LeadNoticeRequest): Promise<void>;
}

/** Self-signup worlds keep their rows while the account exists; a QA world lives two days. */
function worldRetention(worldId: string, now: Date): { expiresAt?: number } {
  return worldId.startsWith("gs-") ? {} : expiry("world", worldId, now);
}

export function provisionOps(ctx: RepoContext) {
  const ticketOp = (worldId: string, requestId: string): WriteOp => {
    const now = ctx.now();
    const item = encode(
      { worldId, requestId, status: "OPEN", requestedAtReal: now.toISOString(), attempts: 0 },
      { entity: "ProvisionRequest", key: keys.runtime(worldId, "PROVISIONREQ", requestId), worldId, now },
    );
    return { kind: "put", table: "Runtime", item: { ...item, expiresAt: expiresAt(now, LEADS_TTL_SECONDS.provisionTicket) }, condition: cond.absent() };
  };

  return {
    ticketOp,

    /** `META` of a new self-signup world: `REGISTERED`, in the queue, written once. */
    worldOp(worldId: string, kind: "GUEST" | "QA"): WriteOp {
      const now = ctx.now();
      const atReal = now.toISOString();
      const meta = { worldId, kind, template: "guest", epoch: 1, status: "REGISTERED", origin: "SIGNUP", requestedAtReal: atReal };
      const item: StoredItem = { ...encode(meta, { entity: "World", key: keys.worldMeta(worldId), worldId, now, indexes: guestQueueAttributes(worldId, "REGISTERED", atReal) }), ...worldRetention(worldId, now) };
      return { kind: "put", table: "Worlds", item, condition: cond.absent() };
    },

    /** The one staff row of the account: `GUEST`, bound to its `sub`, never in a Cognito group. */
    staffOp(worldId: string, sub: string): WriteOp {
      const now = ctx.now();
      const staff = { worldId, staffId: `stf-${worldId}`, role: "GUEST", displayName: "Invitado", cognitoSubKey: keys.subKey(sub), active: true };
      const item: StoredItem = { ...encode(staff, { entity: "Staff", key: keys.staff(worldId, staff.staffId), worldId, now }), ...worldRetention(worldId, now) };
      return { kind: "put", table: "Worlds", item, condition: cond.absent() };
    },

    /** `EXPIRED → REGISTERED` (and back in the queue) with a new ticket: `guest.requestWorld`. */
    requeueOps(worldId: string, requestId: string): WriteOp[] {
      const now = ctx.now().toISOString();
      return [
        {
          kind: "update",
          table: "Worlds",
          key: keys.worldMeta(worldId),
          condition: cond.and(cond.present(), cond.eq("status", "EXPIRED")),
          update: { set: { status: "REGISTERED", requestedAtReal: now, updatedAt: now, ...guestQueueAttributes(worldId, "REGISTERED", now) }, add: { version: 1 } },
        },
        ticketOp(worldId, requestId),
      ];
    },
  };
}
