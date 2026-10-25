// Contract of the outbound gate (docs/architecture-integrations.md §4, ADR-0006): the one path every
// message to a customer takes, whoever asks for it — `ToolMessaging`, `ToolComplaints`, `ToolHandoff`,
// `InboundWhatsApp` (acknowledgement and fixed replies) and the workers (operator, milestones, obligations,
// fallbacks). The caller says what to say; the recipient is always the customer of the request, resolved
// by the gate from the world's data, never from the caller.
import { Channel, ComplaintOutcome, CustomerId, Id, MessageKind, type Reroute, Sender, type ToolFailure, WaButtonAction, WorldId } from "@reclamo/shared";
import { z } from "zod";
import { TemplateName } from "../copy/types";
import type { Actor } from "../domain/common";
import type { Logger } from "../lib/log";
import type { RerouteRequest } from "./reroute";

/** Documents an email may carry (docs/architecture-integrations.md §8). */
export const DocKind = z.enum(["ACK", "ANSWER", "PAYOFF_CERTIFICATE", "CREDIT_NOTE", "STATEMENT", "CLOSURE", "DATA_CHANGE", "COLLECTION_NOTICE"]);
export type DocKind = z.infer<typeof DocKind>;

export interface OutboundButton {
  readonly action: WaButtonAction;
  /** The complaint or loan the button is about; the gate binds it to a nonce of the customer's phone. */
  readonly ref?: string;
}

export interface OutboundTemplate {
  readonly name: TemplateName;
  /** Positional values; `{{3}}` of `reclamo_novedad` is a status phrase id of the closed list. */
  readonly params: readonly string[];
}

export interface OutboundAttachment {
  readonly docKind: DocKind;
  /** The rendered PDF in `Documents`. */
  readonly s3Key: string;
  readonly sha256: string;
}

/** `request = {worldId, customerId, complaintId?, sender, channel, kind, text?, template?, buttons?, attachments?, refs, turnId?, triggerEventId?, rerouteOf?}`. */
export interface OutboundRequest {
  readonly worldId: string;
  readonly customerId: string;
  readonly complaintId?: string;
  /** `AGENT` text is checked by G2 against the turn's tool results; `SYSTEM` text comes from `copy/`. */
  readonly sender: Sender;
  readonly channel: Channel;
  readonly kind: MessageKind;
  readonly text?: string;
  readonly template?: OutboundTemplate;
  readonly buttons?: readonly OutboundButton[];
  /** Email only. */
  readonly subject?: string;
  readonly attachments?: readonly OutboundAttachment[];
  /** Ids and codes every decision of the request carries (tape and audit). */
  readonly refs: Readonly<Record<string, string>>;
  /** The turn whose `TURN#` results ground the text, and the event that opened it. */
  readonly turnId?: string;
  readonly triggerEventId?: string;
  /**
   * The customer's inbound WhatsApp message a `SYSTEM` notice answers (a handoff the customer asked
   * for, the fallback of a turn that message opened). The policy checks it against the thread and the
   * window: a message id that is not the customer's, or an expired window, is still proactive.
   */
  readonly answers?: string;
  /** The tape entry of the `BLOCKED` decision this request reroutes. */
  readonly rerouteOf?: string;
  /** A derived id, so a redelivered event never sends twice; a new one otherwise. */
  readonly messageId?: string;
  /**
   * `FORMAL_ANSWER` only: the resolution the letter answers with, when the complaint has none recorded
   * yet (a human case, or one resolved by an executed approval). A recorded outcome always wins.
   */
  readonly formal?: { readonly outcome: ComplaintOutcome };
}

/** Who asks and how its decisions are recorded. */
export interface OutboundCall {
  readonly actor: Actor;
  readonly correlationId: string;
  readonly log: Logger;
}

/** A permitted path the gate offers for a blocked message (`HUMAN_QUEUE` or `FORMAL_EMAIL`). */
export interface RerouteOffer {
  readonly route: Reroute;
  readonly previewKind?: MessageKind | "COMPLAINT_UPDATE_EMAIL";
}

interface Decided {
  readonly messageId: string;
  readonly tapeId?: string;
  readonly ruleIds: readonly string[];
}

export interface GateAllowed extends Decided {
  readonly ok: true;
  readonly decision: "ALLOWED";
  readonly providerMessageId?: string;
  readonly mailId?: string;
  /** Step 0: the same WhatsApp asked twice in the turn answers with the message already sent. */
  readonly replayOf?: string;
}

export interface GateDeferred extends Decided {
  readonly ok: true;
  readonly decision: "DEFERRED";
  readonly nextAllowedAt: string;
  readonly timerKey: string;
  /** "jueves 08/10 a las 08:00": what the send tools answer as `deferredUntilText`. */
  readonly deferredUntilText?: string;
}

export interface GateRerouted extends Decided {
  readonly ok: true;
  readonly decision: "REROUTED";
  readonly reroutedTo: Reroute;
  readonly childTapeId?: string;
}

export interface GateRefused {
  readonly ok: false;
  /** `BLOCKED` when a decision reached the tape; absent when the gate could not decide (unavailable). */
  readonly decision?: "BLOCKED";
  readonly messageId?: string;
  readonly tapeId?: string;
  readonly ruleIds: readonly string[];
  readonly reroutes?: readonly RerouteOffer[];
  readonly failure: ToolFailure;
}

export type GateOutcome = GateAllowed | GateDeferred | GateRerouted | GateRefused;

/** The request at the gate's edge (zod, strict): what a caller or a fired timer hands over. */
export const OutboundRequestSchema = z
  .object({
    worldId: WorldId,
    customerId: CustomerId,
    complaintId: Id.optional(),
    sender: Sender,
    channel: Channel,
    kind: MessageKind,
    text: z.string().max(20_000).optional(),
    template: z.object({ name: TemplateName, params: z.array(z.string().max(300)).max(10) }).strict().optional(),
    buttons: z.array(z.object({ action: WaButtonAction, ref: Id.optional() }).strict()).max(10).optional(),
    subject: z.string().max(300).optional(),
    attachments: z.array(z.object({ docKind: DocKind, s3Key: z.string().min(1).max(512), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(5).optional(),
    refs: z.record(z.string().max(60), z.string().max(200)),
    turnId: Id.optional(),
    triggerEventId: Id.optional(),
    answers: Id.optional(),
    rerouteOf: Id.optional(),
    messageId: Id.optional(),
    formal: z.object({ outcome: ComplaintOutcome }).strict().optional(),
  })
  .strict();

/** The signature of `sendThroughGate`; tools and workers receive it as a port, so tests swap it. */
export type OutboundGate = (request: OutboundRequest, call: OutboundCall) => Promise<GateOutcome>;

/** Picks a permitted path for a blocked message (outbound/reroute.ts), over a gate of its own. */
export type OperatorReroute = (input: RerouteRequest, call: OutboundCall) => Promise<GateOutcome>;

/** `reason` of the refusals the gate answers itself (a policy block carries its rule instead). */
export const GATE_REASON = {
  GROUNDING_FAIL: "GROUNDING_FAIL",
  GUARDRAIL_UNAVAILABLE: "GUARDRAIL_UNAVAILABLE",
  NO_RECIPIENT: "NO_RECIPIENT",
  CONTENT_INVALID: "CONTENT_INVALID",
  SEND_FAILED: "SEND_FAILED",
  ANSWER_NOT_CLAIMED: "ANSWER_NOT_CLAIMED",
  MAIL_CAP: "MAILCAP",
  ALREADY_DECIDED: "ALREADY_DECIDED",
} as const;

/** Rule ids the gate writes on the tape besides the `CH-*` rules of the policy. */
export const GATE_RULE = {
  G2: "G2",
  VERIFY: "VERIFY",
  /** The daily email cap of a self-signup world (`W#<w>#MAILCAP#<realDay>`, ADR-0020). */
  MAIL_CAP: "MAILCAP",
} as const;

/** `AuditLog.action` of what the gate decides outside the tape. */
export const GATE_AUDIT = {
  REPLAYED: "OUTBOUND_REPLAYED",
  G2_REFUSED: "OUTBOUND_G2_REFUSED",
  UNKNOWN_DELIVERY: "OUTBOUND_UNKNOWN_DELIVERY",
  SEND_FAILED: "OUTBOUND_SEND_FAILED",
  MAIL_CAP: "OUTBOUND_MAILCAP",
  HUMAN_QUEUE: "REROUTE_HUMAN_QUEUE",
} as const;
