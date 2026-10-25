// `Runtime` items that make an effect happen once or within a limit (docs/architecture.md §5, §7,
// §13): idempotency and send claims, button nonces, turn sessions and their results, abuse counters
// on the real clock, the identity challenge ledger, the scan registry of every `Media` object,
// simulated media, live phones, QA phone leases and probes.
import { z } from "zod";
import { Channel, IsoInstant, TurnTrigger, WaButtonAction, WorldId } from "@reclamo/shared";
import { CustomerId, Id, JsonObject, StaffId, Stamps } from "./common";

/** `W#<w>#IDEMP#<source>#<id>`: the first writer wins; a repeat reads what the first stored. */
export const Idempotency = z.object({ worldId: WorldId, source: Id, id: Id, atReal: IsoInstant, result: JsonObject.optional(), ...Stamps });
export type Idempotency = z.infer<typeof Idempotency>;

/** `W#<w>#SEND#<messageId>`: taken before the transport; without `providerMessageId` it is an unknown delivery. */
export const SendClaim = z.object({
  worldId: WorldId,
  messageId: Id,
  channel: Channel,
  claimedAtReal: IsoInstant,
  providerMessageId: z.string().min(1).max(256).optional(),
  dispatchedAtReal: IsoInstant.optional(),
  ...Stamps,
});
export type SendClaim = z.infer<typeof SendClaim>;

/** `LEASE#PHONE#<n>`: a QA phone of the reserve, held by one run until it expires. */
export const Lease = z.object({ leaseKey: z.string().min(1).max(120), holder: z.string().min(1).max(120), leaseUntilReal: IsoInstant, ...Stamps });
export type Lease = z.infer<typeof Lease>;

/** `W#<w>#NONCE#<nonce>`: an opaque button id bound to a phone and a complaint or loan. */
export const Nonce = z.object({
  worldId: WorldId,
  nonce: Id,
  action: WaButtonAction,
  phoneHash: z.string().min(1).max(128),
  customerId: CustomerId.optional(),
  complaintId: Id.optional(),
  loanId: Id.optional(),
  messageId: Id.optional(),
  createdAtReal: IsoInstant,
  usedAtReal: IsoInstant.optional(),
  ...Stamps,
});
export type Nonce = z.infer<typeof Nonce>;

/** `W#<w>#SESSION#<sessionId>`: what a `sessionToken` resolves to (docs/architecture.md §9.1). */
export const Session = z.object({
  worldId: WorldId,
  sessionId: Id,
  customerId: CustomerId,
  complaintIds: z.array(Id),
  identified: z.boolean(),
  trigger: TurnTrigger,
  triggerEventId: Id,
  /** The customer's inbound message the turn answers (a `CUSTOMER_MESSAGE` or a `RECEIPT_RECEIVED`): what a tool takes a value from. */
  inboundMessageId: Id.optional(),
  turnId: Id,
  eventAtSim: IsoInstant,
  createdAtReal: IsoInstant,
  ...Stamps,
});
export type Session = z.infer<typeof Session>;

/** `W#<w>#TURN#<turnId>` META: a token of a closed turn is refused by every tool. */
export const Turn = z.object({
  worldId: WorldId,
  turnId: Id,
  sessionId: Id,
  status: z.enum(["OPEN", "CLOSED"]),
  openedAtReal: IsoInstant,
  closedAtReal: IsoInstant.optional(),
  resultSeq: z.number().int().nonnegative().default(0),
  ...Stamps,
});
export type Turn = z.infer<typeof Turn>;

/** `RESULT#<tool>#<seq>`: a redacted tool result, the grounding source of G2 and of the verifier. */
export const TurnResult = z.object({ worldId: WorldId, turnId: Id, tool: Id, seq: z.number().int().positive(), atReal: IsoInstant, result: JsonObject, ...Stamps });
export type TurnResult = z.infer<typeof TurnResult>;

/** A counter of an abuse cap on the real clock (`RATE#`, `TURNCAP#`, `IMGCAP#`, `GLOBALCAP#`). */
export const CapCounter = z.object({ count: z.number().int().nonnegative(), ...Stamps });
export type CapCounter = z.infer<typeof CapCounter>;

/** `W#<w>#CHALLENGE#<customerId>`: failed challenges of a customer (real time) and the lock. */
export const ChallengeLedger = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  failures: z.array(IsoInstant),
  lockedAtReal: IsoInstant.optional(),
  unlockedBy: StaffId.optional(),
  ...Stamps,
});
export type ChallengeLedger = z.infer<typeof ChallengeLedger>;

export const ScanSource = z.enum(["SIMULATOR", "WHATSAPP", "SEED_COPY"]);
export type ScanSource = z.infer<typeof ScanSource>;

export const ScanResultStatus = z.enum(["NO_THREATS_FOUND", "THREATS_FOUND", "ACCESS_DENIED", "FAILED", "UNSUPPORTED", "TIMEOUT"]);
export type ScanResultStatus = z.infer<typeof ScanResultStatus>;

/**
 * `W#<w>#SCANOBJ#<sha256(announceKey)[0:32]>`: written before the object can exist; the scan result
 * and the message meet here in any order and whoever completes both resolves it once (§6).
 */
export const ScanObject = z.object({
  worldId: WorldId,
  announceKey: z.string().min(1).max(512),
  s3Key: z.string().min(1).max(512).optional(),
  source: ScanSource,
  createdAtReal: IsoInstant,
  result: ScanResultStatus.optional(),
  resultAtReal: IsoInstant.optional(),
  messageId: Id.optional(),
  customerId: CustomerId.optional(),
  boundAtReal: IsoInstant.optional(),
  resolvedAtReal: IsoInstant.optional(),
  resolution: z.enum(["RESULT_FIRST", "BIND_FIRST"]).optional(),
  ...Stamps,
});
export type ScanObject = z.infer<typeof ScanObject>;

/** `W#<w>#SIMMEDIA#<id>`: a simulated media id (`SIM<32 hex>`) and the object it stands for. */
export const SimMedia = z.object({
  worldId: WorldId,
  simMediaId: z.string().regex(/^SIM[0-9a-f]{32}$/),
  s3Key: z.string().min(1).max(512),
  contentType: z.enum(["image/jpeg", "image/png"]),
  createdAtReal: IsoInstant,
  ...Stamps,
});
export type SimMedia = z.infer<typeof SimMedia>;

/** `LIVEPHONE#<phoneHash>`: the only way a live WhatsApp sender resolves to a world. */
export const LivePhone = z.object({ phoneHash: z.string().min(1).max(128), worldId: WorldId, leaseUntilReal: IsoInstant.optional(), ...Stamps });
export type LivePhone = z.infer<typeof LivePhone>;

/** `PROBE#<id>`: a QA probe's before/after record. */
export const Probe = z.object({ probeId: Id, atReal: IsoInstant, data: JsonObject, ...Stamps });
export type Probe = z.infer<typeof Probe>;
