// The append-only records (docs/architecture.md §5, §8.3, ADR-0014): the complaint register (`REG#`),
// the refund register (`RRI#`) and the compliance tape (`TAPE#`) are hash chains, one per world and
// epoch, whose heads live in `Runtime/W#<w>#COUNTER#{REGSEQ|RRISEQ|TAPESEQ}#e<epoch>`; the audit log
// (`AuditLog`) is append-only without a chain. `seq`, `prevHash` and `hash` are computed by
// complaints/register.ts (`appendChained`); the connector writes them with the conditional head.
import { z } from "zod";
import { CollectionCategory } from "../copy/types";
import {
  Channel,
  ComplaintOrigin,
  ComplaintStatus,
  ComplaintType,
  DispatchResult,
  IsoInstant,
  MessageKind,
  PresentationKind,
  Reroute,
  Sender,
  TapeEntryKind,
  WorldId,
} from "@reclamo/shared";
import { Actor, Cents, ComplaintNumber, CustomerId, Epoch, Id, JsonObject, Stamps } from "./common";

export const ChainKind = z.enum(["REG", "RRI", "TAPE"]);
export type ChainKind = z.infer<typeof ChainKind>;

/** Head of a chain: the last `seq` written and its `hash`. */
export const ChainHead = z.object({ value: z.number().int().nonnegative(), hash: z.string().min(1).max(128) });
export type ChainHead = z.infer<typeof ChainHead>;

const Chained = {
  worldId: WorldId,
  epoch: Epoch,
  seq: z.number().int().positive(),
  /** Hash of the previous entry (the genesis value for `seq = 1` is the register module's). */
  prevHash: z.string().max(128),
  hash: z.string().min(1).max(128),
  atSim: IsoInstant,
  atReal: IsoInstant,
  ...Stamps,
};

export const RegisterEventType = z.enum(["FILED", "STATUS", "PROVISIONAL_ANSWER", "FINAL_ANSWER", "DELIVERY_PROOF", "WITHDRAWN", "RECLASSIFIED"]);
export type RegisterEventType = z.infer<typeof RegisterEventType>;

/** The presenter's document as the core masks it (`DNI ••••4417`). */
export const Presenter = z.object({ docType: z.string().min(1).max(20), docNumberMasked: z.string().min(1).max(40) });

/** An immutable event of the complaint register; `FILED` carries the minimum data of BCRA 3.1.3. */
export const RegisterEntry = z.object({
  ...Chained,
  eventType: RegisterEventType,
  complaintId: Id,
  complaintNumber: ComplaintNumber,
  kind: PresentationKind,
  type: ComplaintType,
  channel: Channel,
  origin: ComplaintOrigin,
  reason: z.string().max(300).optional(),
  presenter: Presenter.optional(),
  status: ComplaintStatus.optional(),
  answerRef: Id.optional(),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type RegisterEntry = z.infer<typeof RegisterEntry>;

/** An entry of the refund register (reversals and refunds). */
export const RefundEntry = z.object({
  ...Chained,
  customerId: CustomerId,
  complaintId: Id.optional(),
  complaintNumber: ComplaintNumber.optional(),
  actionId: Id,
  cause: z.enum(["REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"]),
  product: z.string().min(1).max(60),
  amountCents: Cents.positive(),
  interestCents: Cents.nonnegative(),
  creditNoteId: Id.optional(),
});
export type RefundEntry = z.infer<typeof RefundEntry>;

export const RuleEvaluation = z.object({ ruleId: z.string().min(1).max(60), result: z.string().min(1).max(40) });

/** One decision of the outbound gate, or the result of one dispatch (`DISPATCH`). */
export const TapeEntry = z.object({
  ...Chained,
  tapeId: Id,
  decision: TapeEntryKind,
  result: DispatchResult.optional(),
  ruleIds: z.array(z.string().min(1).max(60)).max(40),
  evaluated: z.array(RuleEvaluation).max(60),
  ruleSetVersion: z.string().min(1).max(40),
  sender: Sender,
  channel: Channel,
  kind: MessageKind,
  /** SHA-256 of the exact rendered body. */
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  messageId: Id.optional(),
  providerMessageId: z.string().min(1).max(256).optional(),
  complaintId: Id.optional(),
  /** Hash of the customer (never the id in clear). */
  customerRef: z.string().min(1).max(128).optional(),
  reroute: z.object({ route: Reroute, childTapeId: Id.optional() }).optional(),
  rerouteOf: Id.optional(),
  nextAllowedAt: IsoInstant.optional(),
  /** `BLOCKED` by the collection lexicon: the categories the text tripped (never the text). */
  collectionCategories: z.array(CollectionCategory).max(5).optional(),
});
export type TapeEntry = z.infer<typeof TapeEntry>;

/** Anything that is not an outbound message: tools with effects, approvals, logins, clock, resets, denials. */
export const AuditEntry = z.object({
  worldId: WorldId,
  epoch: Epoch,
  auditId: Id,
  /** Real instant (audit stamps are real time). */
  ts: IsoInstant,
  atSim: IsoInstant.optional(),
  action: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  actor: Actor,
  ruleIds: z.array(z.string().min(1).max(60)).max(40).optional(),
  refs: z.record(z.string(), z.string().max(200)),
  /** The ref the `ByRef` index files this entry under (`CMP#<id>`, `CUS#<id>`, `TURN#<id>`). */
  primaryRef: z.string().regex(/^[A-Z]+#[A-Za-z0-9._:+=@-]{1,160}$/).optional(),
  outcome: z.string().max(80).optional(),
  detail: JsonObject.optional(),
  ...Stamps,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/**
 * The entries of one epoch. `ComplianceTape` and `AuditLog` are append-only and a reset never wipes
 * them, so every view of "this world" (tape, metrics, a complaint's timeline) keeps only the current
 * epoch's entries: seeded complaints keep their ids across epochs.
 */
export function ofEpoch<T extends { readonly epoch: number }>(entries: readonly T[], epoch: number): T[] {
  return entries.filter((entry) => entry.epoch === epoch);
}
