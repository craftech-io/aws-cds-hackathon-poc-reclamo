// The new value of a `request_data_change` (docs/tool-catalog.md, FL-054): read by code from the
// customer's own words, never written by the model. A message only gives a value that looks like one:
//
//   EMAIL     the first email address of the message
//   ADDRESS   the message, bounded, when it reads as a street address: a word and a street number (or
//             "s/n"), never a bare date or a short numeric answer
//   any       a reply the customer gave to the identity challenge (`IDEMP#CHALLENGE_ANSWER#<messageId>`)
//             is never a new value, whatever it says
//
// Without a message named, the turn's message is read first and, if it holds no value, the customer's
// earlier messages of the complaint, newest first: the customer may have written the new address before
// answering the challenge. Nothing found → `NO_NEW_VALUE`, and the agent waits for the customer to write it.
import { ToolError } from "@reclamo/shared";
import type { DataChangeField } from "../../copy/types";
import type { Complaint } from "../../domain/complaint";
import type { Message } from "../../domain/conversation";
import type { ToolContext } from "../common/context";
import { ANSWER_CLAIM_SOURCE } from "../identity/customer-answer";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}/;
const MAX_VALUE = 200;
const MIN_ADDRESS = 8;
/** Newest messages of the thread searched for an earlier value. */
const LOOKBACK = 30;

const WORD = /\p{L}{3,}/u;
/** A street number: digits that are not part of a date (`12/9`, `12-09-1985`), or "s/n". */
const STREET_NUMBER = /(?<![\d/.-])\d{1,5}(?![\d]|[/.-]\d)|\bs\/n\b|\bsin n[uú]mero\b/iu;
const SPELLED_DATE = /\b\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/iu;

/** Reads as a street address: a word, a street number and more than a date. */
export function looksLikeAddress(text: string): boolean {
  return text.length >= MIN_ADDRESS && WORD.test(text) && STREET_NUMBER.test(text) && !SPELLED_DATE.test(text);
}

/** The new value the customer wrote, as code reads it from the stored (masked) message; never the model. */
export function extractNewValue(field: DataChangeField, body: string): string | undefined {
  if (field === "PHONE") return undefined;
  if (field === "EMAIL") return EMAIL_PATTERN.exec(body)?.[0];
  const text = body.replace(/\s+/g, " ").trim();
  return looksLikeAddress(text) ? text.slice(0, MAX_VALUE) : undefined;
}

export interface NewValue {
  readonly value: string;
  readonly messageId: string;
}

const NO_NEW_VALUE = "the customer's message holds no new value for this field (an answer to the identity challenge never does): do not call it again now; ask the customer to write the new value and call it in the turn of their reply";

async function valueOfMessage(ctx: ToolContext<unknown>, field: DataChangeField, message: Message): Promise<NewValue | undefined> {
  const value = extractNewValue(field, message.body);
  if (value === undefined) return undefined;
  const answeredChallenge = await ctx.connector.claims.getIdempotency(ctx.session.worldId, ANSWER_CLAIM_SOURCE, message.messageId);
  return answeredChallenge === undefined ? { value, messageId: message.messageId } : undefined;
}

/** The customer's earlier messages of the complaint (the one that filed it and those after), newest first. */
async function earlierMessages(ctx: ToolContext<unknown>, complaint: Complaint, except: string): Promise<Message[]> {
  const thread = await ctx.connector.conversations.listMessages(ctx.session.worldId, ctx.session.customerId, { limit: LOOKBACK, descending: true });
  const ofComplaint = (message: Message): boolean => message.messageId === complaint.sourceMessageId || Date.parse(message.atSim) >= Date.parse(complaint.filedAtSim);
  return thread.filter((message) => message.direction === "IN" && message.messageId !== except && ofComplaint(message));
}

/** The new email or address of the change: from the named message, else the turn's or an earlier one of the complaint. */
export async function newValueOf(ctx: ToolContext<unknown>, complaint: Complaint, field: Exclude<DataChangeField, "PHONE">, source: { readonly messageId: string; readonly named: boolean }): Promise<NewValue> {
  const message = await ctx.connector.conversations.findMessage(ctx.session.worldId, ctx.session.customerId, source.messageId);
  if (message === undefined || message.direction !== "IN") throw new ToolError("FORBIDDEN", "not a message of this customer", "NOT_IN_SESSION");
  const own = await valueOfMessage(ctx, field, message);
  if (own !== undefined) return own;
  if (!source.named) {
    for (const earlier of await earlierMessages(ctx, complaint, message.messageId)) {
      const found = await valueOfMessage(ctx, field, earlier);
      if (found !== undefined) return found;
    }
  }
  throw new ToolError("INVALID", NO_NEW_VALUE, "NO_NEW_VALUE");
}
