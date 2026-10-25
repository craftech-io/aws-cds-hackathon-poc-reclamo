// `Conversations`: a customer's conversation (`META`: control, identification, window, disclosure,
// open complaints), its messages, provider events and turn notes. Control changes are conditional on
// the control they leave and on `version` (docs/architecture.md §5); the automation disclosure is
// marked once per session epoch with a `contains` condition, so two senders never both skip it.
import { z } from "zod";
import type { Actor } from "../../domain/common";
import type { Control } from "../../domain/complaint";
import { ConversationMeta, ConversationTask, EmailRecord, Message, MessageEvent, TurnNote } from "../../domain/conversation";
import { type CreateMode, type NewOf, type RepoContext, createGuard, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys, sortInstant, worldIndexAttributes, worldKey } from "../keys";
import { type StoredItem, type WriteOp, cond } from "../store";

const TABLE = "Conversations" as const;

export const ConversationPatch = ConversationMeta.pick({
  identifiedAtReal: true,
  identifiedUntilReal: true,
  windowOpenUntilSim: true,
  lastInboundAtSim: true,
  sessionEpoch: true,
  openComplaintIds: true,
  processError: true,
}).partial();
export type ConversationPatch = z.infer<typeof ConversationPatch>;

/**
 * What an update may change. `flags` has no default here: a patch without it (a WhatsApp status, a
 * settle) leaves the stored flags, `flags.disclosure` included, as they are.
 */
export const MessagePatch = Message.pick({ status: true, providerMessageId: true, sentAtSim: true, tapeRef: true, media: true })
  .extend({ flags: z.object({ disclosure: z.boolean().optional() }).optional() })
  .partial();
export type MessagePatch = z.infer<typeof MessagePatch>;

export interface MessageRef {
  readonly worldId: string;
  readonly customerId: string;
  readonly atSim: string;
  readonly messageId: string;
}

export type ProviderIdMatch = { readonly kind: "MESSAGE"; readonly message: Message } | { readonly kind: "EMAIL"; readonly email: EmailRecord };

/** Index attributes of a sent outbound message or email: `ByCustomerSent` counts contacts per day and window. */
export function sentIndexes(worldId: string, customerId: string, sentAtSim: string | undefined) {
  return sentAtSim ? { customerSentKey: worldKey(worldId, "CUS", customerId), sentAtSort: sortInstant(sentAtSim) } : {};
}

export function conversationsRepo(ctx: RepoContext) {
  const partition = (worldId: string, customerId: string) => keys.conversationPartition(worldId, customerId);
  const stamp = () => ctx.now().toISOString();
  const newItem = (entity: string, value: { worldId: string }, key: { pk: string; sk: string }, indexes: Record<string, string | undefined> = {}) =>
    encode(value, { entity, key, worldId: value.worldId, retention: "conversation", now: ctx.now(), indexes: { ...indexes, ...worldIndexAttributes(value.worldId, key) } });

  const createOp = (meta: NewOf<typeof ConversationMeta>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(ConversationMeta, { ...meta, version: 1 }, TABLE);
    return { kind: "put", table: TABLE, item: newItem("Conversation", value, keys.conversation(value.worldId, value.customerId)), ...createGuard(mode) };
  };

  const updateMetaOp = (worldId: string, customerId: string, version: number, patch: ConversationPatch): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: keys.conversation(worldId, customerId),
    condition: cond.eq("version", version),
    update: { set: { ...validInput(ConversationPatch, patch, TABLE), version: version + 1, updatedAt: stamp() } },
  });

  const putMessageOp = (message: NewOf<typeof Message>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(Message, { ...message, version: 1 }, TABLE);
    const key = keys.message(value.worldId, value.customerId, value.atSim, value.messageId);
    return { kind: "put", table: TABLE, item: newItem("Message", value, key, sentIndexes(value.worldId, value.customerId, value.sentAtSim)), ...createGuard(mode) };
  };

  const updateMessageOp = (ref: MessageRef, patch: MessagePatch, version?: number): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: keys.message(ref.worldId, ref.customerId, ref.atSim, ref.messageId),
    condition: version === undefined ? cond.present() : cond.eq("version", version),
    update: { set: { ...validInput(MessagePatch, patch, TABLE), ...sentIndexes(ref.worldId, ref.customerId, patch.sentAtSim), updatedAt: stamp() }, add: { version: 1 } },
  });

  const listPrefix = async (worldId: string, customerId: string, prefix: string, options: { limit?: number; descending?: boolean } = {}) =>
    queryAll(ctx.store, { table: TABLE, partition: partition(worldId, customerId), sort: { op: "beginsWith", value: prefix }, ...(options.descending ? { descending: true } : {}) }, options.limit ?? 1_000);

  return {
    async getMeta(worldId: string, customerId: string, options: { consistent?: boolean } = {}): Promise<ConversationMeta | undefined> {
      return decodeOptional(ConversationMeta, await ctx.store.get(TABLE, keys.conversation(worldId, customerId), options), TABLE);
    },
    createOp,
    async create(meta: NewOf<typeof ConversationMeta>): Promise<void> {
      await ctx.store.write(createOp(meta));
    },
    /** A versioned change of the conversation (identification, window, session epoch, open complaints, lost event). */
    updateMetaOp,
    async updateMeta(worldId: string, customerId: string, version: number, patch: ConversationPatch): Promise<ConversationMeta> {
      return decode(ConversationMeta, (await ctx.store.write(updateMetaOp(worldId, customerId, version, patch))) as StoredItem, TABLE);
    },

    /** Take-over and hand-back: `control` moves only from the control the caller saw, on `version`. */
    setControlOp(request: { worldId: string; customerId: string; version: number; from: Control; to: Control; by: Actor; atSim: string; staffId?: string }): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: keys.conversation(request.worldId, request.customerId),
        condition: cond.and(cond.eq("version", request.version), cond.eq("control", request.from)),
        update: {
          set: { control: request.to, ...(request.to === "OPERATOR" ? { controlledBy: request.staffId } : {}), version: request.version + 1, updatedAt: stamp() },
          append: { controlHistory: [{ from: request.from, to: request.to, atSim: request.atSim, by: request.by }] },
          ...(request.to === "AGENT" ? { remove: ["controlledBy"] } : {}),
        },
      };
    },

    /** Marks the disclosure of a session epoch; a `CONFLICT` means another outbound already carried it. */
    markDisclosedOp(worldId: string, customerId: string, sessionEpoch: number): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: keys.conversation(worldId, customerId),
        condition: cond.and(cond.present(), cond.not(cond.contains("disclosedEpochs", sessionEpoch))),
        update: { append: { disclosedEpochs: [sessionEpoch] }, set: { updatedAt: stamp() }, add: { version: 1 } },
      };
    },

    putMessageOp,
    async putMessage(message: NewOf<typeof Message>): Promise<void> {
      await ctx.store.write(putMessageOp(message));
    },
    /** Status, provider id, dispatch time or tape reference of a message; with `version`, only over that one. */
    updateMessageOp,
    async updateMessage(ref: MessageRef, patch: MessagePatch, version?: number): Promise<Message> {
      return decode(Message, (await ctx.store.write(updateMessageOp(ref, patch, version))) as StoredItem, TABLE);
    },
    async getMessage(ref: MessageRef): Promise<Message | undefined> {
      return decodeOptional(Message, await ctx.store.get(TABLE, keys.message(ref.worldId, ref.customerId, ref.atSim, ref.messageId), { consistent: true }), TABLE);
    },
    /** A message by id alone (a conversation holds tens of messages). */
    async findMessage(worldId: string, customerId: string, messageId: string): Promise<Message | undefined> {
      const item = (await listPrefix(worldId, customerId, "MSG#")).find((candidate) => candidate.messageId === messageId);
      return item ? decode(Message, item, TABLE) : undefined;
    },
    /** The thread in time order (or newest first). */
    async listMessages(worldId: string, customerId: string, options: { limit?: number; descending?: boolean } = {}): Promise<Message[]> {
      return (await listPrefix(worldId, customerId, "MSG#", options)).map((item) => decode(Message, item, TABLE));
    },
    /** Messages and emails sent to a customer since a simulated instant (contact caps and window, index `ByCustomerSent`). */
    async listSentSince(worldId: string, customerId: string, sinceSim: string): Promise<{ messages: Message[]; emails: EmailRecord[] }> {
      const items = await queryAll(ctx.store, { table: TABLE, index: "ByCustomerSent", partition: worldKey(worldId, "CUS", customerId), sort: { op: "ge", value: sortInstant(sinceSim) } });
      return {
        messages: items.filter((item) => item.entity === "Message").map((item) => decode(Message, item, TABLE)),
        emails: items.filter((item) => item.entity === "EmailRecord").map((item) => decode(EmailRecord, item, TABLE)),
      };
    },
    /** The message or email a provider id (`wamid`, SES `MessageId`) belongs to (index `ByProviderMessageId`). */
    async findByProviderMessageId(providerMessageId: string): Promise<ProviderIdMatch | undefined> {
      const page = await ctx.store.query({ table: TABLE, index: "ByProviderMessageId", partition: providerMessageId, limit: 2 });
      const item = page.items[0];
      if (!item) return undefined;
      return item.entity === "EmailRecord" ? { kind: "EMAIL", email: decode(EmailRecord, item, TABLE) } : { kind: "MESSAGE", message: decode(Message, item, TABLE) };
    },

    putEventOp(event: NewOf<typeof MessageEvent>, mode: CreateMode = {}): WriteOp {
      const value = validInput(MessageEvent, event, TABLE);
      return { kind: "put", table: TABLE, item: newItem("MessageEvent", value, keys.messageEvent(value.worldId, value.customerId, value.atReal, value.eventId)), ...createGuard(mode) };
    },
    async listEvents(worldId: string, customerId: string): Promise<MessageEvent[]> {
      return (await listPrefix(worldId, customerId, "EVT#")).map((item) => decode(MessageEvent, item, TABLE));
    },

    putTurnNoteOp(note: NewOf<typeof TurnNote>, mode: CreateMode = {}): WriteOp {
      const value = validInput(TurnNote, note, TABLE);
      return { kind: "put", table: TABLE, item: newItem("TurnNote", value, keys.turnNote(value.worldId, value.customerId, value.atSim, value.turnId)), ...createGuard(mode) };
    },
    async listTurnNotes(worldId: string, customerId: string): Promise<TurnNote[]> {
      return (await listPrefix(worldId, customerId, "NOTE#")).map((item) => decode(TurnNote, item, TABLE));
    },

    /** A human task of the conversation (no complaint yet). */
    putTaskOp(task: NewOf<typeof ConversationTask>, mode: CreateMode = {}): WriteOp {
      const value = validInput(ConversationTask, task, TABLE);
      return { kind: "put", table: TABLE, item: newItem("ConversationTask", value, keys.conversationTask(value.worldId, value.customerId, value.atSim, value.taskId)), ...createGuard(mode) };
    },
    async listTasks(worldId: string, customerId: string): Promise<ConversationTask[]> {
      return (await listPrefix(worldId, customerId, "TASK#")).map((item) => decode(ConversationTask, item, TABLE));
    },
    /** Closes an open task once. */
    completeTaskOp(worldId: string, customerId: string, task: { atSim: string; taskId: string }, done: { doneBy: string; doneAtSim: string }): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: keys.conversationTask(worldId, customerId, task.atSim, task.taskId),
        condition: cond.eq("task.status", "OPEN"),
        update: { set: { "task.status": "DONE", "task.doneBy": done.doneBy, "task.doneAtSim": done.doneAtSim, updatedAt: stamp() } },
      };
    },
  };
}

export type ConversationsRepo = ReturnType<typeof conversationsRepo>;
