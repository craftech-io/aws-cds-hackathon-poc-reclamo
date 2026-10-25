// Emails sent through SES (`Conversations/…/MAIL#`): what the email viewer lists (index `EmailIndex`)
// and what `EmailEvents` matches a configuration-set event against (`ByProviderMessageId`), so a
// fabricated event for an email we never sent finds nothing (docs/architecture.md §13).
import { EmailRecord, type EmailEventType } from "../../domain/conversation";
import type { DeliveryProof } from "../../domain/complaint";
import type { JsonObject } from "../../domain/common";
import { type CreateMode, type NewOf, type RepoContext, createGuard, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys, worldIndexAttributes, worldKey } from "../keys";
import { sentIndexes } from "./conversations";
import { type WriteOp, cond } from "../store";

const TABLE = "Conversations" as const;

export interface MailRef {
  readonly worldId: string;
  readonly customerId: string;
  readonly sentAtSim: string;
  readonly mailId: string;
}

export function emailsRepo(ctx: RepoContext) {
  const key = (ref: MailRef) => keys.email(ref.worldId, ref.customerId, ref.sentAtSim, ref.mailId);

  const putOp = (record: NewOf<typeof EmailRecord>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(EmailRecord, { ...record, version: 1 }, TABLE);
    const itemKey = key(value);
    const item = encode(value, {
      entity: "EmailRecord",
      key: itemKey,
      worldId: value.worldId,
      retention: "conversation",
      now: ctx.now(),
      indexes: { emailIndexKey: worldKey(value.worldId, "MAIL"), ...sentIndexes(value.worldId, value.customerId, value.sentAtSim), ...worldIndexAttributes(value.worldId, itemKey) },
    });
    return { kind: "put", table: TABLE, item, ...createGuard(mode) };
  };

  return {
    /** The record of an email, written before it is sent (the `.eml` is already in S3 `Emails`). */
    putOp,
    async put(record: NewOf<typeof EmailRecord>): Promise<void> {
      await ctx.store.write(putOp(record));
    },
    async get(ref: MailRef): Promise<EmailRecord | undefined> {
      return decodeOptional(EmailRecord, await ctx.store.get(TABLE, key(ref), { consistent: true }), TABLE);
    },
    /** An email of a customer by id alone. */
    async find(worldId: string, customerId: string, mailId: string): Promise<EmailRecord | undefined> {
      const items = await queryAll(ctx.store, { table: TABLE, partition: keys.conversationPartition(worldId, customerId), sort: { op: "beginsWith", value: "MAIL#" } });
      const item = items.find((candidate) => candidate.mailId === mailId);
      return item ? decode(EmailRecord, item, TABLE) : undefined;
    },
    /** SES accepted it: its `MessageId`, once. */
    setProviderMessageIdOp(ref: MailRef, providerMessageId: string): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: key(ref),
        condition: cond.and(cond.present(), cond.notExists("providerMessageId")),
        update: { set: { providerMessageId, deliveryProof: "SENT", updatedAt: ctx.now().toISOString() }, add: { version: 1 } },
      };
    },
    /** An SES event of this email: appended, and the delivery proof it establishes. */
    recordEventOp(ref: MailRef, event: { type: EmailEventType; atReal: string; detail?: JsonObject }, deliveryProof?: DeliveryProof): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: key(ref),
        condition: cond.present(),
        update: { append: { events: [event] }, set: { deliveryProof, updatedAt: ctx.now().toISOString() }, add: { version: 1 } },
      };
    },
    /** The world's emails for the viewer, newest first (index `EmailIndex`). */
    async listWorld(worldId: string, options: { limit?: number; cursor?: string } = {}) {
      const page = await ctx.store.query({
        table: TABLE,
        index: "EmailIndex",
        partition: worldKey(worldId, "MAIL"),
        descending: true,
        limit: options.limit ?? 50,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      return { emails: page.items.map((item) => decode(EmailRecord, item, TABLE)), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  };
}

export type EmailsRepo = ReturnType<typeof emailsRepo>;
