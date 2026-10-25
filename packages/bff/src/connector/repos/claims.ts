// Claims that make an effect happen once (docs/architecture.md §4 of the integrations, §5, §7):
// idempotency per source event, the send claim of every outbound message (taken before the
// transport: a claim without a provider id is an unknown delivery, never a blind resend), button
// nonces, QA phone leases, live phones, simulated media and probes.
import type { Channel } from "@reclamo/shared";
import { Idempotency, Lease, LivePhone, Nonce, Probe, SendClaim, SimMedia } from "../../domain/runtime-claims";
import type { JsonObject } from "../../domain/common";
import { type NewOf, type RepoContext, decodeOptional, encode, validInput } from "../codec";
import { isConflict } from "../errors";
import { keys, segment } from "../keys";
import { type WriteOp, cond } from "../store";

const TABLE = "Runtime" as const;

export type IdempotencyClaim = { readonly first: true } | { readonly first: false; readonly existing: Idempotency };

/** What a send claim says about a message: go ahead, already sent, or sent-maybe (a person decides). */
export type SendClaimOutcome =
  | { readonly status: "CLAIMED" }
  | { readonly status: "SENT"; readonly providerMessageId: string }
  | { readonly status: "UNKNOWN_DELIVERY" };

export function claimsRepo(ctx: RepoContext) {
  const idempotencyKey = (worldId: string, source: string, id: string) => keys.runtime(worldId, "IDEMP", segment(source, "idempotency source"), segment(id, "idempotency id"));
  const sendKey = (worldId: string, messageId: string) => keys.runtime(worldId, "SEND", segment(messageId, "message id"));
  const nonceKey = (worldId: string, nonce: string) => keys.runtime(worldId, "NONCE", segment(nonce, "nonce"));
  const leaseKey = (key: string) => keys.global("LEASE", ...key.split("#").map((part) => segment(part, "lease key")));
  const livePhoneKey = (phoneHash: string) => keys.global("LIVEPHONE", segment(phoneHash, "phone hash"));

  const getIdempotency = async (worldId: string, source: string, id: string) =>
    decodeOptional(Idempotency, await ctx.store.get(TABLE, idempotencyKey(worldId, source, id), { consistent: true }), TABLE);

  const idempotencyOp = (worldId: string, source: string, id: string, result?: JsonObject): WriteOp => {
    const value = validInput(Idempotency, { worldId, source, id, atReal: ctx.now().toISOString(), result }, TABLE);
    return { kind: "put", table: TABLE, item: encode(value, { entity: "Idempotency", key: idempotencyKey(worldId, source, id), worldId, retention: "idempotency", now: ctx.now() }), condition: cond.absent() };
  };

  const getSendClaim = async (worldId: string, messageId: string) => decodeOptional(SendClaim, await ctx.store.get(TABLE, sendKey(worldId, messageId), { consistent: true }), TABLE);

  return {
    /** `IDEMP#<source>#<id>` as an operation: rides with the effect it guards (`IDEMP#REGISTER#<eventId>`, §8.2). */
    idempotencyOp,
    getIdempotency,
    /** First writer wins; a repeat gets what the first stored (the same complaint number, the same result). */
    async claimOnce(worldId: string, source: string, id: string, result?: JsonObject): Promise<IdempotencyClaim> {
      try {
        await ctx.store.write(idempotencyOp(worldId, source, id, result));
        return { first: true };
      } catch (error) {
        if (!isConflict(error)) throw error;
        const existing = await getIdempotency(worldId, source, id);
        if (!existing) throw error;
        return { first: false, existing };
      }
    },

    /** Step 7 of the gate: `SEND#<messageId>` before the transport (docs/architecture-integrations.md §4). */
    async claimSend(worldId: string, messageId: string, channel: Channel): Promise<SendClaimOutcome> {
      const now = ctx.now();
      const value = validInput(SendClaim, { worldId, messageId, channel, claimedAtReal: now.toISOString() }, TABLE);
      try {
        await ctx.store.write({ kind: "put", table: TABLE, item: encode(value, { entity: "SendClaim", key: sendKey(worldId, messageId), worldId, retention: "cap", now }), condition: cond.absent() });
        return { status: "CLAIMED" };
      } catch (error) {
        if (!isConflict(error)) throw error;
        const existing = await getSendClaim(worldId, messageId);
        return existing?.providerMessageId ? { status: "SENT", providerMessageId: existing.providerMessageId } : { status: "UNKNOWN_DELIVERY" };
      }
    },
    getSendClaim,
    /** The provider accepted the message: its id, once. */
    recordSendOp(worldId: string, messageId: string, providerMessageId: string): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: sendKey(worldId, messageId),
        condition: cond.and(cond.present(), cond.notExists("providerMessageId")),
        update: { set: { providerMessageId, dispatchedAtReal: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() } },
      };
    },

    putNonceOp(nonce: NewOf<typeof Nonce>): WriteOp {
      const value = validInput(Nonce, nonce, TABLE);
      return { kind: "put", table: TABLE, item: encode(value, { entity: "Nonce", key: nonceKey(value.worldId, value.nonce), worldId: value.worldId, retention: "nonce", now: ctx.now() }), condition: cond.absent() };
    },
    async getNonce(worldId: string, nonce: string): Promise<Nonce | undefined> {
      return decodeOptional(Nonce, await ctx.store.get(TABLE, nonceKey(worldId, nonce), { consistent: true }), TABLE);
    },
    /** A button is honoured once. */
    consumeNonceOp(worldId: string, nonce: string): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: nonceKey(worldId, nonce),
        condition: cond.and(cond.present(), cond.notExists("usedAtReal")),
        update: { set: { usedAtReal: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() } },
      };
    },

    /** Takes (or renews) a lease unless another holder has it unexpired; `false` when it is taken. */
    async acquireLease(key: string, holder: string, leaseUntilReal: string): Promise<boolean> {
      const now = ctx.now();
      const value = validInput(Lease, { leaseKey: key, holder, leaseUntilReal }, TABLE);
      const free = cond.or(cond.absent(), cond.lt("leaseUntilReal", now.toISOString()), cond.eq("holder", holder));
      try {
        await ctx.store.write({ kind: "put", table: TABLE, item: encode(value, { entity: "Lease", key: leaseKey(key), retention: "lease", now }), condition: free });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },
    async releaseLease(key: string, holder: string): Promise<void> {
      try {
        await ctx.store.write({ kind: "delete", table: TABLE, key: leaseKey(key), condition: cond.eq("holder", holder) });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    },
    async getLease(key: string): Promise<Lease | undefined> {
      return decodeOptional(Lease, await ctx.store.get(TABLE, leaseKey(key), { consistent: true }), TABLE);
    },

    /** `LIVEPHONE#<phoneHash>` → world: the only way a live sender resolves (docs/architecture.md §13). */
    async putLivePhone(phone: NewOf<typeof LivePhone>): Promise<void> {
      const value = validInput(LivePhone, phone, TABLE);
      // A leased live phone (the QA live world of SC-23) disappears with its lease.
      const lease = value.leaseUntilReal ? { expiresAt: Math.floor(Date.parse(value.leaseUntilReal) / 1000) } : {};
      await ctx.store.write({ kind: "put", table: TABLE, item: { ...encode(value, { entity: "LivePhone", key: livePhoneKey(value.phoneHash), now: ctx.now() }), ...lease } });
    },
    async getLivePhone(phoneHash: string): Promise<LivePhone | undefined> {
      return decodeOptional(LivePhone, await ctx.store.get(TABLE, livePhoneKey(phoneHash), { consistent: true }), TABLE);
    },
    async deleteLivePhone(phoneHash: string, worldId: string): Promise<void> {
      await ctx.store.write({ kind: "delete", table: TABLE, key: livePhoneKey(phoneHash), condition: cond.eq("worldId", worldId) });
    },

    async putSimMedia(media: NewOf<typeof SimMedia>): Promise<void> {
      const value = validInput(SimMedia, media, TABLE);
      const key = keys.runtime(value.worldId, "SIMMEDIA", value.simMediaId);
      await ctx.store.write({ kind: "put", table: TABLE, item: encode(value, { entity: "SimMedia", key, worldId: value.worldId, retention: "pending", now: ctx.now() }), condition: cond.absent() });
    },
    async getSimMedia(worldId: string, simMediaId: string): Promise<SimMedia | undefined> {
      return decodeOptional(SimMedia, await ctx.store.get(TABLE, keys.runtime(worldId, "SIMMEDIA", segment(simMediaId, "media id")), { consistent: true }), TABLE);
    },

    async putProbe(probe: NewOf<typeof Probe>): Promise<void> {
      const value = validInput(Probe, probe, TABLE);
      await ctx.store.write({ kind: "put", table: TABLE, item: encode(value, { entity: "Probe", key: keys.global("PROBE", segment(value.probeId, "probe id")), retention: "pending", now: ctx.now() }) });
    },
    async getProbe(probeId: string): Promise<Probe | undefined> {
      return decodeOptional(Probe, await ctx.store.get(TABLE, keys.global("PROBE", segment(probeId, "probe id")), { consistent: true }), TABLE);
    },
  };
}

export type ClaimsRepo = ReturnType<typeof claimsRepo>;
