// The session of one turn (docs/architecture.md §9.1, docs/tool-catalog.md "Sesión"): before the Harness
// is invoked the worker writes `Runtime/W#<w>#SESSION#<sessionId>` (customer, complaints, identification,
// trigger, event and its simulated instant, the customer's inbound message the turn answers) and `Runtime/W#<w>#TURN#<turnId>`, and signs
// `sessionToken = <worldId>.<sessionId>.<turnId>.<exp>.<HMAC>` with the `session` subkey, valid for at
// most 15 real minutes. Every Gateway tool derives the rest from that row, never from the model. When the
// turn ends the worker closes it, so a token copied out of a turn is refused even before it expires.
import type { TurnTrigger } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import { isConflict } from "../connector/errors";
import { type SecretKey, ulid } from "../lib/crypto";
import { issueSessionToken } from "../services/session";

export interface OpenedTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly token: string;
}

export interface TurnSessionDeps {
  readonly data: Pick<Connector, "sessions">;
  /** `SessionKey` (its `session` subkey signs the token). */
  readonly sessionKey: SecretKey;
  /** Real time: ids order writes, tokens live in real time. */
  readonly now: () => Date;
  /** Injected for tests; 10 random bytes per id. */
  readonly random?: (size: number) => Uint8Array;
}

export interface TurnSessionInput {
  readonly worldId: string;
  readonly customerId: string;
  readonly complaintIds: readonly string[];
  readonly identified: boolean;
  readonly trigger: TurnTrigger;
  readonly triggerEventId: string;
  /** The customer's inbound message the turn answers, when there is one. */
  readonly inboundMessageId?: string;
  readonly eventAtSim: string;
}

/** Writes the session and the open turn, then signs the token (≤ 15 minutes). */
export async function openTurnSession(deps: TurnSessionDeps, input: TurnSessionInput): Promise<OpenedTurn> {
  const nowMs = deps.now().getTime();
  const id = () => (deps.random === undefined ? ulid(nowMs) : ulid(nowMs, deps.random));
  const sessionId = `S${id()}`;
  const turnId = `T${id()}`;
  const atReal = new Date(nowMs).toISOString();
  await deps.data.sessions.putSession({
    worldId: input.worldId,
    sessionId,
    customerId: input.customerId,
    complaintIds: [...new Set(input.complaintIds)],
    identified: input.identified,
    trigger: input.trigger,
    triggerEventId: input.triggerEventId,
    ...(input.inboundMessageId === undefined ? {} : { inboundMessageId: input.inboundMessageId }),
    turnId,
    eventAtSim: input.eventAtSim,
    createdAtReal: atReal,
  });
  await deps.data.sessions.openTurn({ worldId: input.worldId, turnId, sessionId, openedAtReal: atReal });
  const token = issueSessionToken(deps.sessionKey, { worldId: input.worldId, sessionId, turnId }, new Date(nowMs));
  return { sessionId, turnId, token };
}

/** Closes the turn: from here on every tool refuses its token. A turn already closed stays closed. */
export async function closeTurnSession(deps: Pick<TurnSessionDeps, "data">, worldId: string, turnId: string): Promise<void> {
  try {
    await deps.data.sessions.closeTurn(worldId, turnId);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}
