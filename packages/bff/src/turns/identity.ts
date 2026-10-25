// Who the Harness and Memory think a turn belongs to (docs/architecture.md §9.1 and §9.3), in one place
// for the worker, the Memory purge of a world (worlds/memory-purge.ts) and the QaDriver's
// `memory.inspect`:
//
//   actorId           `w-<worldId>-<customerId>-e<worldEpoch>`: the customer ids (`cus-0001`…) and the
//                     first epochs repeat in `demo` and in every guest world, so without the world id the
//                     long-term memory of one guest's customer would show up in another guest's world. A
//                     reset (new epoch) starts a new actor.
//   runtimeSessionId  the keyed hash (`runtime-session` subkey of `SessionKey`) of "conv", world, customer
//                     and both epochs, cut to 48 hex characters: one Harness session per conversation; a
//                     guardrail block of the Harness raises `sessionEpoch` and the next turn starts clean.
//
// Neither carries a phone, an email or a name.
import { CustomerId, WorldId } from "@reclamo/shared";
import { type SecretKey, deriveSubkey, hmacSha256Hex } from "../lib/crypto";

export interface HarnessIdentity {
  readonly actorId: string;
  readonly runtimeSessionId: string;
}

export interface ConversationIdentity {
  readonly worldId: string;
  readonly customerId: string;
  readonly worldEpoch: number;
  readonly sessionEpoch: number;
}

/** AgentCore's actor pattern and length (`[A-Za-z0-9-_/]`, at most 255). */
const ACTOR_PATTERN = /^[A-Za-z0-9_/-]{1,255}$/;

function epochOf(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`invalid ${label} ${value}`);
  return value;
}

/** `w-<worldId>-` with its final dash: the exact prefix the Memory purge of a world lists. */
export function actorPrefixOf(worldId: string): string {
  return `w-${WorldId.parse(worldId)}-`;
}

/** Memory actor of a customer in one epoch of its world. */
export function actorIdOf(worldId: string, customerId: string, worldEpoch: number): string {
  const actorId = `${actorPrefixOf(worldId)}${CustomerId.parse(customerId)}-e${epochOf(worldEpoch, "world epoch")}`;
  if (!ACTOR_PATTERN.test(actorId)) throw new RangeError("the actor id breaks AgentCore's pattern");
  return actorId;
}

/** `runtimeSessionId` of a conversation and its epochs; `runtimeSessionKey` is `SessionKey` itself. */
export function runtimeSessionIdOf(sessionKey: SecretKey, identity: ConversationIdentity): string {
  const subkey = deriveSubkey("SessionKey", sessionKey, "runtime-session");
  const message = ["conv", WorldId.parse(identity.worldId), CustomerId.parse(identity.customerId), epochOf(identity.worldEpoch, "world epoch"), epochOf(identity.sessionEpoch, "session epoch")].join("\u0000");
  return hmacSha256Hex(subkey, message).slice(0, 48);
}

export function harnessIdentity(sessionKey: SecretKey, identity: ConversationIdentity): HarnessIdentity {
  return { actorId: actorIdOf(identity.worldId, identity.customerId, identity.worldEpoch), runtimeSessionId: runtimeSessionIdOf(sessionKey, identity) };
}
