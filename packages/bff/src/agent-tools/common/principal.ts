// Who a tool call acts for (docs/tool-catalog.md "Sesión" and "Invocación directa", `LAM-CALLER` of
// docs/design-brief.md §8.6).
//
// The only principal of the Gateway is the Harness, and it proves nothing by itself: every call carries
// the `sessionToken` the worker signed for the turn, and the world, customer, complaints, identification,
// trigger and simulated instant are read from `Runtime/W#<worldId>#SESSION#<sessionId>`. A token of a
// closed turn is refused.
//
// The deployed entry of a target accepts nothing else: an event that names a `caller` (or brings no
// token) is `INVALID` and audited `DENY DIRECT_INVOKE` before anything is read, because inside the account
// a resource policy does not stop a principal whose identity policy allows `lambda:InvokeFunction`. The
// `caller` variant is only a function signature: the worker (preloaded reads) imports the target and calls
// it in process with the principal it already authenticated, and still with the turn's token, so the same
// session and the same fences apply.
import { Caller, ERROR_REASON, ToolError, type TurnTrigger, WorldId } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import type { Session } from "../../domain/runtime-claims";
import type { SecretKey } from "../../lib/crypto";
import { verifySessionToken } from "../../services/session";
import { GATEWAY_TOOL_SEPARATOR } from "./targets";

/** Keys AgentCore Gateway puts in `context.clientContext.custom` of a Lambda target invocation. */
export const GATEWAY_CONTEXT_KEYS = [
  "bedrockAgentCoreMessageVersion",
  "bedrockAgentCoreAwsRequestId",
  "bedrockAgentCoreMcpMessageId",
  "bedrockAgentCoreGatewayId",
  "bedrockAgentCoreTargetId",
  "bedrockAgentCoreToolName",
] as const;

/** What a target reads from the Lambda context; the Node runtime gives the client context as sent. */
export interface LambdaContextLike {
  readonly awsRequestId?: string;
  readonly clientContext?: unknown;
}

export interface GatewayMarks {
  readonly present: boolean;
  /** `<target>___<tool>`. */
  readonly toolName?: string;
  readonly requestId?: string;
}

function customOf(clientContext: unknown): Record<string, unknown> | undefined {
  if (typeof clientContext !== "object" || clientContext === null) return undefined;
  const custom = Reflect.get(clientContext, "custom") ?? Reflect.get(clientContext, "Custom");
  return typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>) : undefined;
}

export function gatewayMarksOf(context: LambdaContextLike | undefined): GatewayMarks {
  const custom = customOf(context?.clientContext);
  if (custom === undefined) return { present: false };
  const toolName = custom["bedrockAgentCoreToolName"];
  const requestId = custom["bedrockAgentCoreAwsRequestId"];
  return {
    present: GATEWAY_CONTEXT_KEYS.some((key) => key in custom),
    ...(typeof toolName === "string" ? { toolName } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}

/** The context the Gateway gives a target for `<target>___<tool>`: what local flows and tests pass. */
export function gatewayContext(action: string, requestId = "local-gateway-request"): LambdaContextLike {
  return {
    awsRequestId: requestId,
    clientContext: {
      custom: {
        bedrockAgentCoreMessageVersion: "1.0",
        bedrockAgentCoreAwsRequestId: requestId,
        bedrockAgentCoreMcpMessageId: requestId,
        bedrockAgentCoreGatewayId: "local-gateway",
        bedrockAgentCoreTargetId: action.split(GATEWAY_TOOL_SEPARATOR)[0] ?? "",
        bedrockAgentCoreToolName: action,
      },
    },
  };
}

/** Who the implementation acts for: the Harness through the Gateway, or an in-process caller. */
export type ToolPrincipal = { readonly kind: "HARNESS" } | { readonly kind: "CALLER"; readonly caller: Caller };

/** What the session of the turn says; nothing of it comes from the model's input. */
export interface ToolSession {
  readonly worldId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly customerId: string;
  readonly complaintIds: readonly string[];
  readonly trigger: TurnTrigger;
  readonly triggerEventId: string;
  /** The customer's inbound message the turn answers: the default source of a tool that reads the customer's words. */
  readonly inboundMessageId?: string;
  /** "Now" of every rule of the call: the simulated instant of the event that opened the turn (ADR-0011). */
  readonly eventAtSim: string;
  /** Real instant the worker opened the turn: what the customer wrote before it is what the turn saw. */
  readonly openedAtReal: string;
}

export function toolSessionOf(session: Session): ToolSession {
  const { worldId, sessionId, turnId, customerId, complaintIds, trigger, triggerEventId, inboundMessageId, eventAtSim, createdAtReal } = session;
  return { worldId, sessionId, turnId, customerId, complaintIds: [...complaintIds], trigger, triggerEventId, ...(inboundMessageId === undefined ? {} : { inboundMessageId }), eventAtSim, openedAtReal: createdAtReal };
}

/**
 * The customer's message a tool reads: the one the model named (already checked by `LAM-SCOPE` against the
 * customer's inbound messages), else the inbound message the turn answers; `undefined` when the turn has none.
 */
export function sourceMessageIdOf(session: Pick<ToolSession, "inboundMessageId">, named: string | undefined): string | undefined {
  return named ?? session.inboundMessageId;
}

/** Why a principal was refused, as the tool error's `reason` says it. */
export const PRINCIPAL_REASON = {
  DIRECT_INVOKE: "DIRECT_INVOKE",
  CALLER_INVALID: "CALLER_INVALID",
  CALLER_NOT_ALLOWED: ERROR_REASON.ROLE_NOT_ALLOWED,
  CROSS_WORLD: ERROR_REASON.CROSS_WORLD,
  TURN_CLOSED: "TURN_CLOSED",
} as const;

export type SessionResolution =
  | { readonly ok: true; readonly session: ToolSession }
  | { readonly ok: false; readonly error: ToolError; readonly closedSession?: ToolSession };

const invalid = () => new ToolError("FORBIDDEN", "invalid session token", ERROR_REASON.SESSION_INVALID);

/**
 * The world an authentic token names, read from its signature alone (expired or not): where a refusal
 * of a direct invocation that carried it is audited. A forged token names no world.
 */
export function signedWorldOf(sessionKey: SecretKey, token: unknown, now: Date): string | undefined {
  if (typeof token !== "string") return undefined;
  const verified = verifySessionToken(sessionKey, token, now);
  if (verified.ok) return verified.claims.worldId;
  if (verified.reason !== "EXPIRED") return undefined;
  const worldId = token.split(".")[0];
  return WorldId.safeParse(worldId).success ? worldId : undefined;
}

/**
 * Signature and expiry (real time), then the stored session of that turn, then the turn still open.
 * A token refused only because its turn closed returns the session too, so the refusal is audited in
 * its world; forged, expired and unknown tokens name no one and leave only a log line.
 */
export async function resolveToolSession(sessionKey: SecretKey, token: unknown, connector: Connector, now: Date): Promise<SessionResolution> {
  if (typeof token !== "string") return { ok: false, error: invalid() };
  const verified = verifySessionToken(sessionKey, token, now);
  if (!verified.ok) {
    const reason = verified.reason === "EXPIRED" ? ERROR_REASON.SESSION_EXPIRED : ERROR_REASON.SESSION_INVALID;
    return { ok: false, error: new ToolError("FORBIDDEN", "the session token is not valid for this turn", reason) };
  }
  const { worldId, sessionId, turnId } = verified.claims;
  const stored = await connector.sessions.getSession(worldId, sessionId);
  if (stored === undefined || stored.turnId !== turnId) return { ok: false, error: invalid() };
  const session = toolSessionOf(stored);
  const turn = await connector.sessions.getTurn(worldId, turnId);
  if (turn === undefined || turn.sessionId !== sessionId) return { ok: false, error: invalid() };
  if (turn.status !== "OPEN") {
    return { ok: false, error: new ToolError("FORBIDDEN", "the turn of this token is closed", ERROR_REASON.SESSION_EXPIRED), closedSession: session };
  }
  return { ok: true, session };
}

/** The caller of an in-process call, parsed; `undefined` when it is not a valid `Caller`. */
export function parseCaller(caller: unknown): Caller | undefined {
  const parsed = Caller.safeParse(caller);
  return parsed.success ? parsed.data : undefined;
}
