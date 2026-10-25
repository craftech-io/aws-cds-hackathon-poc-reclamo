// The customer's own answer to the identity challenge (CLAUDE.md, "Identidad fuera del modelo";
// docs/tool-catalog.md `verify_challenge`). The model relays an answer, but only the customer can give
// one: `verify_challenge` checks the fragment of an inbound message of the session's conversation that
// states it, never the model's string. Everything comes from the session the token names:
//
//   asked     the latest `IDENTITY_CHALLENGE` of the conversation that went out (`wentOut`); without
//             one, nothing the customer wrote is an answer (`CHALLENGE_NOT_ASKED`)
//   replies   the customer's inbound messages written AFTER it and no later than the turn opened (the
//             turn saw them in its envelope), on the REAL clock: the world clock, which a guest moves,
//             never orders them; a challenge sent again in the same turn starts over
//   written   the reply that states the answer (`answer.ts`); none → `ANSWER_NOT_WRITTEN`
//   once      `IDEMP#CHALLENGE_ANSWER#<messageId>`: a reply is checked once, right or wrong; a reply
//             already checked → `ANSWER_ALREADY_USED`
//
// A refusal is the model's mistake, not the customer's: it is audited and never counted as a failure.
import type { ChallengeKind } from "@reclamo/core-contract";
import { ToolError } from "@reclamo/shared";
import { wentOut } from "../../channel-policy/kinds";
import type { Message } from "../../domain/conversation";
import type { ToolContext } from "../common/context";
import { writtenFragment } from "./answer";

export const ANSWER_REFUSAL = {
  NOT_ASKED: "CHALLENGE_NOT_ASKED",
  NOT_WRITTEN: "ANSWER_NOT_WRITTEN",
  ALREADY_USED: "ANSWER_ALREADY_USED",
} as const;
export type AnswerRefusal = (typeof ANSWER_REFUSAL)[keyof typeof ANSWER_REFUSAL];

/** Idempotency source of a reply checked as an answer. */
export const ANSWER_CLAIM_SOURCE = "CHALLENGE_ANSWER";
/** Newest messages of the thread read: a challenge older than that is not pending any more. */
export const THREAD_WINDOW = 100;

const REFUSAL_TEXT: Readonly<Record<AnswerRefusal, string>> = {
  CHALLENGE_NOT_ASKED: "the identity challenge has not reached the customer: send its promptText with send_whatsapp kind IDENTITY_CHALLENGE and wait for their reply",
  ANSWER_NOT_WRITTEN: "the customer has not written this answer since the challenge was asked: wait for their reply and pass it exactly as they wrote it, never a value of your own",
  ANSWER_ALREADY_USED: "that reply of the customer was already checked: ask the challenge again and wait for a new reply",
};

export interface CustomerAnswer {
  readonly messageId: string;
  /** What the customer wrote that states the answer: the only text the core compares. */
  readonly fragment: string;
}

export interface PendingReplies {
  readonly asked: boolean;
  /** Newest first. */
  readonly replies: readonly Message[];
}

function realMsOf(message: Message): number | undefined {
  const at = message.createdAt === undefined ? Number.NaN : Date.parse(message.createdAt);
  return Number.isNaN(at) ? undefined : at;
}

/** Pure: whether a challenge went out, and what the customer wrote after it up to the turn's opening. */
export function pendingReplies(thread: readonly Message[], openedAtReal: string): PendingReplies {
  const openedMs = Date.parse(openedAtReal);
  const askedMs = thread
    .filter((message) => message.kind === "IDENTITY_CHALLENGE" && wentOut(message))
    .map(realMsOf)
    .filter((at): at is number => at !== undefined)
    .reduce<number | undefined>((latest, at) => (latest === undefined || at > latest ? at : latest), undefined);
  if (askedMs === undefined) return { asked: false, replies: [] };
  const replies = thread
    .filter((message) => message.direction === "IN" && message.channel === "WHATSAPP")
    .map((message) => ({ message, at: realMsOf(message) }))
    .filter((entry): entry is { message: Message; at: number } => entry.at !== undefined && entry.at > askedMs && entry.at <= openedMs)
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.message);
  return { asked: true, replies };
}

/** The customer's reply that states `answer`, claimed for this one check; throws the refusal otherwise. */
export async function customerAnswer(ctx: ToolContext<unknown>, kind: ChallengeKind, answer: string): Promise<CustomerAnswer> {
  const { worldId, customerId, openedAtReal, turnId } = ctx.session;
  const refuse = async (reason: AnswerRefusal): Promise<never> => {
    await ctx.audit({ action: "CHALLENGE_ANSWER_REFUSED", outcome: reason, detail: { kind } });
    throw new ToolError("INVALID", REFUSAL_TEXT[reason], reason);
  };
  const thread = await ctx.connector.conversations.listMessages(worldId, customerId, { limit: THREAD_WINDOW, descending: true });
  const pending = pendingReplies(thread, openedAtReal);
  if (!pending.asked) return refuse(ANSWER_REFUSAL.NOT_ASKED);
  const written = pending.replies.flatMap((message) => {
    const fragment = writtenFragment(kind, answer, message.body);
    return fragment === undefined ? [] : [{ messageId: message.messageId, fragment }];
  });
  if (written.length === 0) return refuse(ANSWER_REFUSAL.NOT_WRITTEN);
  for (const candidate of written) {
    const claim = await ctx.connector.claims.claimOnce(worldId, ANSWER_CLAIM_SOURCE, candidate.messageId, { turnId });
    if (claim.first) return candidate;
  }
  return refuse(ANSWER_REFUSAL.ALREADY_USED);
}
