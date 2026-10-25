// `Complaints/…/META`: the complaint, its inbox position and its transitions. `transitionOp` is the
// storage half of `transition()` (complaints/state-machine.ts): a conditional update on `version`
// **and** on the origin states the state machine allows, meant to ride in the same transaction as
// the register entry (docs/architecture.md §8.1). Every other change is conditional on `version` or
// on the answer's own fields, so a double send of a written answer collides here.
import { z } from "zod";
import type { ComplaintStatus } from "@reclamo/shared";
import { Complaint, type ComplaintAnswer, type DeliveryProof, StatusChange, inboxStateOf } from "../../domain/complaint";
import { type CreateMode, type NewOf, type RepoContext, createGuard, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys, sortInstant, worldIndexAttributes, worldKey } from "../keys";
import { type Condition, type StoredItem, type WriteOp, cond } from "../store";

const TABLE = "Complaints" as const;

/** Fields a versioned patch may change; the status only changes through `transitionOp`. */
export const ComplaintPatch = Complaint.pick({
  slaState: true,
  priority: true,
  control: true,
  handoff: true,
  emailAnswerConsent: true,
  outcome: true,
  subject: true,
}).partial();
export type ComplaintPatch = z.infer<typeof ComplaintPatch>;

export interface TransitionRequest {
  readonly worldId: string;
  readonly complaintId: string;
  /** The version the caller read. */
  readonly version: number;
  /** Origin states the state machine allows for `to`. */
  readonly allowedFrom: readonly ComplaintStatus[];
  readonly to: ComplaintStatus;
  readonly change: StatusChange;
  readonly patch?: ComplaintPatch;
}

function inboxAttributes(worldId: string, status: ComplaintStatus): { inboxKey: string } {
  return { inboxKey: worldKey(worldId, inboxStateOf(status)) };
}

export function complaintsRepo(ctx: RepoContext) {
  const key = (worldId: string, complaintId: string) => keys.complaint(worldId, complaintId);
  const stamp = () => ctx.now().toISOString();

  const createOp = (complaint: NewOf<typeof Complaint>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(Complaint, { ...complaint, version: 1 }, TABLE);
    const itemKey = key(value.worldId, value.complaintId);
    const item = encode(value, {
      entity: "Complaint",
      key: itemKey,
      worldId: value.worldId,
      retention: "complaint",
      now: ctx.now(),
      indexes: {
        ...inboxAttributes(value.worldId, value.status),
        deadlineSort: sortInstant(value.deadlineSim),
        customerKey: worldKey(value.worldId, "CUS", value.customerId),
        filedAtSort: sortInstant(value.filedAtSim),
        numberKey: worldKey(value.worldId, value.complaintNumber),
        ...worldIndexAttributes(value.worldId, itemKey),
      },
    });
    return { kind: "put", table: TABLE, item, ...createGuard(mode) };
  };

  const transitionOp = (request: TransitionRequest): WriteOp => {
    if (request.allowedFrom.length === 0) throw new RangeError("a transition needs at least one origin state");
    const change = validInput(StatusChange, request.change, TABLE);
    const patch = validInput(ComplaintPatch, request.patch ?? {}, TABLE);
    return {
      kind: "update",
      table: TABLE,
      key: key(request.worldId, request.complaintId),
      condition: cond.and(cond.eq("version", request.version), cond.in("status", request.allowedFrom)),
      update: {
        set: { ...patch, status: request.to, ...inboxAttributes(request.worldId, request.to), version: request.version + 1, updatedAt: stamp() },
        append: { statusHistory: [change] },
      },
    };
  };

  const patchOp = (worldId: string, complaintId: string, version: number, patch: ComplaintPatch): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: key(worldId, complaintId),
    condition: cond.eq("version", version),
    update: { set: { ...validInput(ComplaintPatch, patch, TABLE), version: version + 1, updatedAt: stamp() } },
  });

  const answerOp = (worldId: string, complaintId: string, condition: Condition, set: Record<string, unknown>, remove?: string[]): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: key(worldId, complaintId),
    condition: cond.and(cond.present(), condition),
    update: { set: { ...set, updatedAt: stamp() }, add: { version: 1 }, ...(remove ? { remove } : {}) },
  });

  const decodeAll = (items: readonly StoredItem[]) => items.map((item) => decode(Complaint, item, TABLE));

  return {
    async get(worldId: string, complaintId: string, options: { consistent?: boolean } = {}): Promise<Complaint | undefined> {
      return decodeOptional(Complaint, await ctx.store.get(TABLE, key(worldId, complaintId), options), TABLE);
    },

    async getByNumber(worldId: string, complaintNumber: string): Promise<Complaint | undefined> {
      const page = await ctx.store.query({ table: TABLE, index: "ByNumber", partition: worldKey(worldId, complaintNumber), limit: 1 });
      return page.items[0] ? decode(Complaint, page.items[0], TABLE) : undefined;
    },

    /** A customer's complaints, newest first (index `ByCustomer`). */
    async listByCustomer(worldId: string, customerId: string, limit = 50): Promise<Complaint[]> {
      const page = await ctx.store.query({ table: TABLE, index: "ByCustomer", partition: worldKey(worldId, "CUS", customerId), descending: true, limit });
      return decodeAll(page.items);
    },

    /** The inbox: open (or closed) complaints by deadline (index `InboxIndex`). */
    async listInbox(worldId: string, options: { state?: "OPEN" | "CLOSED"; limit?: number; cursor?: string } = {}): Promise<{ complaints: Complaint[]; cursor?: string }> {
      const page = await ctx.store.query({
        table: TABLE,
        index: "InboxIndex",
        partition: worldKey(worldId, options.state ?? "OPEN"),
        limit: options.limit ?? 50,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      return { complaints: decodeAll(page.items), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    /** Every open complaint of the world, by deadline (SLA sweeps and quiescence). */
    async listOpen(worldId: string): Promise<Complaint[]> {
      return decodeAll(await queryAll(ctx.store, { table: TABLE, index: "InboxIndex", partition: worldKey(worldId, "OPEN") }));
    },

    /** Puts a new complaint (`attribute_not_exists`): part of the numbering transaction (§8.2); `replace` for the factory. */
    createOp,

    /** The storage half of `transition()`: `version = :v AND status IN (:allowedFrom)`, history appended. */
    transitionOp,

    /** A versioned change of non-status fields (SLA state, priority, control mirror, handoff, consent, outcome). */
    patchOp,
    async patch(worldId: string, complaintId: string, version: number, patch: ComplaintPatch): Promise<Complaint> {
      const after = await ctx.store.write(patchOp(worldId, complaintId, version, patch));
      return decode(Complaint, after as StoredItem, TABLE);
    },

    /** `answer.inFlight = messageId` unless an answer is already in flight or sent: a double send collides. */
    claimAnswerOp(worldId: string, complaintId: string, messageId: string): WriteOp {
      const answer: ComplaintAnswer = { inFlight: messageId };
      return answerOp(worldId, complaintId, cond.and(cond.notExists("answer.inFlight"), cond.notExists("answer.messageId")), { answer });
    },

    /** Frees the claim when the send did not happen (the gate blocked or deferred it). */
    releaseAnswerOp(worldId: string, complaintId: string, messageId: string): WriteOp {
      return answerOp(worldId, complaintId, cond.eq("answer.inFlight", messageId), {}, ["answer.inFlight"]);
    },

    /** The answer went out: `answer = {messageId, mailId, sentAtSim, deliveryProof: SENT}`. */
    recordAnswerSentOp(worldId: string, complaintId: string, sent: { messageId: string; mailId: string; sentAtSim: string }): WriteOp {
      const answer: ComplaintAnswer = { ...sent, deliveryProof: "SENT" };
      return answerOp(worldId, complaintId, cond.eq("answer.inFlight", sent.messageId), { answer });
    },

    /** The delivery proof of the sent answer, from its SES events. */
    setDeliveryProofOp(worldId: string, complaintId: string, messageId: string, proof: DeliveryProof): WriteOp {
      return answerOp(worldId, complaintId, cond.eq("answer.messageId", messageId), { "answer.deliveryProof": proof });
    },
  };
}

export type ComplaintsRepo = ReturnType<typeof complaintsRepo>;
