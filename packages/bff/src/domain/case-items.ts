// What hangs from a complaint in its partition (docs/architecture.md §5): evidence (`EVD#`), actions
// (`ACT#`), approvals (`APR#`), executions of an approved action (`EXEC#`, written once) and notes
// (`NOTE#`, including the human tasks of a reroute). Evidence details are plain JSON owned by the
// tool that produced them (receipts/, reconcile/, agent-tools/); the envelope is validated here.
import { z } from "zod";
import { CapAction, CapTier, IsoInstant, Reroute, WorldId } from "@reclamo/shared";
import { Actor, Cents, Epoch, Id, JsonObject, StaffId, Stamps, Versioned } from "./common";

export const EvidenceKind = z.enum([
  "RECEIPT_IMAGE",
  "RECEIPT_READING",
  "SETTLEMENT_MATCH",
  "CHARGE_CHECK",
  "DUPLICATE_CHECK",
  "TRANSFER_STATUS",
  "DISBURSEMENT",
  "TERMS_CLAUSE",
  "LOAN_STATUS",
  "PAYOFF_QUOTE",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  worldId: WorldId,
  complaintId: Id,
  evidenceId: Id,
  kind: EvidenceKind,
  /** The id a tool returned for it (`readingId`, `reconciliationId`, `chargeCheckId`, `duplicateCheckId`). */
  refId: Id.optional(),
  atSim: IsoInstant,
  actor: Actor,
  turnId: Id.optional(),
  details: JsonObject,
  ...Stamps,
});
export type Evidence = z.infer<typeof Evidence>;

export const ActionKind = z.enum(["APPLY_PAYMENT", "REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL", "FREEZE_OUTGOING", "ACCOUNT_CLOSURE", "DATA_CHANGE"]);
export type ActionKind = z.infer<typeof ActionKind>;

export const ActionStatus = z.enum(["EXECUTED", "CONFLICT", "PENDING_CONFIRMATION", "REFERRED", "FAILED"]);
export type ActionStatus = z.infer<typeof ActionStatus>;

/** An action on the core. Money actions carry the natural-key claim the core took (`OPC#`, `REV#`, `RFD#`, `TRV#`). */
export const Action = z.object({
  worldId: WorldId,
  complaintId: Id,
  actionId: Id,
  kind: ActionKind,
  status: ActionStatus,
  amountCents: Cents.nonnegative().optional(),
  /** Reference the core returned (movement, credit note, closure request). */
  coreRef: Id.optional(),
  idempotencyKey: z.string().min(1).max(200),
  claimKey: z.string().regex(/^(OPC|REV|RFD|TRV)#[A-Za-z0-9._:#-]{1,160}$/).optional(),
  evidenceId: Id.optional(),
  approvalId: Id.optional(),
  /** `DATA_CHANGE`: the field asked for (its confirmation email names it). */
  dataChangeField: z.enum(["EMAIL", "ADDRESS", "PHONE"]).optional(),
  /** `ACCOUNT_CLOSURE`: the conditions the core stated (its confirmation email and PDF list them). */
  closureConditions: z.array(z.enum(["ACTIVE_LOAN", "WALLET_BALANCE", "PENDING_TRANSFER"])).max(10).optional(),
  atSim: IsoInstant,
  actor: Actor,
  ...Stamps,
});
export type Action = z.infer<typeof Action>;

export const ApprovalDecision = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** A request for a person to approve a money action above the agent's cap. Nothing in the agent decides it. */
export const Approval = z.object({
  worldId: WorldId,
  complaintId: Id,
  approvalId: Id,
  action: CapAction,
  amountCents: Cents.positive(),
  capTier: CapTier.exclude(["AGENT"]),
  evidenceId: Id,
  justification: z.string().max(500),
  requestedBy: z.literal("AGENT"),
  requestedAtSim: IsoInstant,
  decision: ApprovalDecision,
  decidedBy: StaffId.optional(),
  decidedAtSim: IsoInstant.optional(),
  reason: z.string().max(500).optional(),
  /** World epoch when requested: a reset expires it. */
  epoch: Epoch,
  /** Two simulated business days after the request. */
  expiresAtSim: IsoInstant,
  /** Real instant the worker executed it; present at most once. */
  executedAt: IsoInstant.optional(),
  ...Versioned,
});
export type Approval = z.infer<typeof Approval>;

/** `EXEC#<approvalId>`: the single execution of an approved action (docs/architecture.md §8.5). */
export const Execution = z.object({
  worldId: WorldId,
  complaintId: Id,
  approvalId: Id,
  executedAtReal: IsoInstant,
  executedAtSim: IsoInstant,
  /** The event whose delivery claimed it: only a redelivery of that same event resumes it. */
  eventId: Id.optional(),
  outcome: z.enum(["EXECUTED", "ABOVE_CAP", "CONFLICT", "FAILED"]).optional(),
  actionId: Id.optional(),
  ...Stamps,
});
export type Execution = z.infer<typeof Execution>;

export const NoteKind = z.enum(["NOTE", "HUMAN_TASK", "SLA"]);
export type NoteKind = z.infer<typeof NoteKind>;

export const HumanTask = z.object({
  status: z.enum(["OPEN", "DONE"]),
  route: Reroute.optional(),
  tapeId: Id.optional(),
  doneBy: StaffId.optional(),
  doneAtSim: IsoInstant.optional(),
});
export type HumanTask = z.infer<typeof HumanTask>;

export const Note = z.object({
  worldId: WorldId,
  complaintId: Id,
  noteId: Id,
  kind: NoteKind,
  atSim: IsoInstant,
  author: Actor,
  text: z.string().max(2_000),
  task: HumanTask.optional(),
  ...Stamps,
});
export type Note = z.infer<typeof Note>;
