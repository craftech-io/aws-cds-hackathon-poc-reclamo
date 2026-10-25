// Enums every edge shares: docs/tool-catalog.md "Tipos compartidos", as zod schemas and types.
import { z } from "zod";

/** Consulta (answered, not registered) or reclamo (registered with its number on the spot). */
export const PresentationKind = z.enum(["CONSULTA", "RECLAMO"]);
export type PresentationKind = z.infer<typeof PresentationKind>;

export const ComplaintType = z.enum([
  "PAYMENT_NOT_REFLECTED",
  "PAYOFF_CERTIFICATE",
  "UNRECOGNIZED_CHARGE",
  "DUPLICATE_DEBIT",
  "TRANSFER_NOT_CREDITED",
  "DISBURSEMENT_NOT_RECEIVED",
  "UNKNOWN_OPERATION",
  "ACCOUNT_BLOCKED",
  "CLOSURE_OR_EARLY_PAYOFF",
  "DATA_CHANGE",
  "INFORMATION_REQUEST",
]);
export type ComplaintType = z.infer<typeof ComplaintType>;

export const ComplaintStatus = z.enum([
  "REGISTERED",
  "INVESTIGATING",
  "AWAITING_CUSTOMER",
  "AWAITING_SETTLEMENT",
  "AWAITING_NETWORK",
  "AWAITING_APPROVAL",
  "HUMAN_REVIEW",
  "RESOLVED",
  "ANSWERED",
  "CLOSED",
]);
export type ComplaintStatus = z.infer<typeof ComplaintStatus>;

export const ComplaintOrigin = z.enum(["SEED", "LIVE"]);
export type ComplaintOrigin = z.infer<typeof ComplaintOrigin>;

export const ComplaintOutcome = z.enum(["IN_FAVOUR", "PARTIALLY_IN_FAVOUR", "NOT_IN_FAVOUR", "INFORMATIONAL", "WITHDRAWN"]);
export type ComplaintOutcome = z.infer<typeof ComplaintOutcome>;

export const SlaState = z.enum(["ON_TIME", "AT_RISK", "OVERDUE"]);
export type SlaState = z.infer<typeof SlaState>;

export const SlaMilestone = z.enum(["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"]);
export type SlaMilestone = z.infer<typeof SlaMilestone>;

export const HandoffReason = z.enum([
  "CUSTOMER_ASKED",
  "LOW_CONFIDENCE",
  "TWO_FAILED_ATTEMPTS",
  "FRAUD",
  "ABOVE_CAP",
  "IDENTITY_VERIFICATION",
  "RECEIPT_NOT_FOUND",
  "RECEIPT_DOUBT",
  "ACCOUNT_BLOCKED",
  "RISKY_DATA_CHANGE",
  "EMAIL_UNDELIVERABLE",
  "GUARDRAIL_BLOCK",
  "OTHER",
]);
export type HandoffReason = z.infer<typeof HandoffReason>;

export const CapAction = z.enum(["APPLY_PAYMENT", "REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"]);
export type CapAction = z.infer<typeof CapAction>;

export const CapTier = z.enum(["AGENT", "OPERATOR", "SUPERVISOR"]);
export type CapTier = z.infer<typeof CapTier>;

export const Network = z.enum(["NORTE", "SUR", "TRANSFER", "WALLET"]);
export type Network = z.infer<typeof Network>;

export const ReconciliationResult = z.enum(["MATCHED", "PAYER_MISMATCH", "ALREADY_APPLIED", "PENDING_BATCH", "NOT_FOUND", "AMOUNT_MISMATCH"]);
export type ReconciliationResult = z.infer<typeof ReconciliationResult>;

export const ReceiptResult = z.enum(["READ", "UNREADABLE", "INVALID_RECEIPT", "DISAGREE", "NOT_A_RECEIPT", "DUPLICATE_OF"]);
export type ReceiptResult = z.infer<typeof ReceiptResult>;

/** Channels a message travels on (docs/architecture-integrations.md). */
export const Channel = z.enum(["WHATSAPP", "EMAIL"]);
export type Channel = z.infer<typeof Channel>;

/** How a channel runs in a world (ADR-0002, infra/channel-modes.ts). */
export const ChannelMode = z.enum(["live", "simulated"]);
export type ChannelMode = z.infer<typeof ChannelMode>;

/** Key of a channel in `ChannelModes` (infra/channel-modes.ts). */
export const ChannelName = z.enum(["email", "whatsapp"]);
export type ChannelName = z.infer<typeof ChannelName>;

export function channelNameOf(channel: Channel): ChannelName {
  return channel === "EMAIL" ? "email" : "whatsapp";
}

/** `AGENT`, `SYSTEM` or `OPERATOR:<staffId>`. */
export const Sender = z.union([z.literal("AGENT"), z.literal("SYSTEM"), z.string().regex(/^OPERATOR:stf-[a-z0-9-]+$/)]);
export type Sender = z.infer<typeof Sender>;

export const MessageKind = z.enum([
  "COMPLAINT_ACK",
  "ACK_EMAIL",
  "IDENTITY_CHALLENGE",
  "REPLY",
  "RECEIPT_REQUEST",
  "COMPLAINT_UPDATE",
  "RESOLUTION_NOTICE",
  "FORMAL_ANSWER",
  "HANDOFF_NOTICE",
  "HOLDING_NOTICE",
  "OPERATOR_MESSAGE",
  "SAFETY_GUIDANCE",
  "OUT_OF_SCOPE_REFUSAL",
  "OPT_OUT_CONFIRMATION",
  "DATA_CHANGE_CONFIRMATION",
  "CLOSURE_CONFIRMATION",
  "SUPERVISOR_ALERT",
  "COLLECTION_REMINDER",
  "COLLECTION_NOTICE_EMAIL",
]);
export type MessageKind = z.infer<typeof MessageKind>;

export const GateDecision = z.enum(["ALLOWED", "BLOCKED", "REROUTED", "DEFERRED"]);
export type GateDecision = z.infer<typeof GateDecision>;

export const TapeEntryKind = z.enum(["ALLOWED", "BLOCKED", "REROUTED", "DEFERRED", "DISPATCH"]);
export type TapeEntryKind = z.infer<typeof TapeEntryKind>;

export const DispatchResult = z.enum(["SENT", "FAILED", "UNKNOWN_DELIVERY"]);
export type DispatchResult = z.infer<typeof DispatchResult>;

export const TurnTrigger = z.enum([
  "CUSTOMER_MESSAGE",
  "RECEIPT_RECEIVED",
  "SETTLEMENT_PUBLISHED",
  "TRANSFER_STATUS_CHANGED",
  "APPROVAL_DECIDED",
  "OPERATOR_RELEASED",
  "ANSWER_DUE",
  "RECONCILE_DUE",
  "EMAIL_EVENT",
]);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

export const Reroute = z.enum(["HUMAN_QUEUE", "FORMAL_EMAIL"]);
export type Reroute = z.infer<typeof Reroute>;

export const TimerKind = z.enum(["SLA", "DEFERRED_SEND", "SETTLEMENT_PUBLISH", "SETTLEMENT_RECHECK", "NETWORK_TRANSITION", "FOLLOW_UP", "AUTO_CLOSE"]);
export type TimerKind = z.infer<typeof TimerKind>;

export const TimerFiredBy = z.enum(["SCHEDULER", "CLOCK", "PUBLICATION", "MANUAL"]);
export type TimerFiredBy = z.infer<typeof TimerFiredBy>;

export const ClockMode = z.enum(["PAUSED", "RUNNING"]);
export type ClockMode = z.infer<typeof ClockMode>;

/** Console roles (docs/design-brief.md §9); `COMPLIANCE` is read-only. */
export const StaffRole = z.enum(["OPERATOR", "SUPERVISOR", "COMPLIANCE", "GUEST"]);
export type StaffRole = z.infer<typeof StaffRole>;

export const WaButtonAction = z.enum([
  "TALK_TO_HUMAN",
  "ACCEPT_EMAIL",
  "DECLINE_EMAIL",
  "CHOOSE_LOAN",
  "OPT_OUT",
  "CONFIRM_CLOSURE",
  "WITHDRAW",
  "SEE_DETAIL",
  "HAVE_A_QUESTION",
]);
export type WaButtonAction = z.infer<typeof WaButtonAction>;

export const PreferredChannel = z.enum(["WHATSAPP", "EMAIL"]);
export type PreferredChannel = z.infer<typeof PreferredChannel>;
export const ContactWindow = z.enum(["MORNING", "AFTERNOON", "ANY"]);
export type ContactWindow = z.infer<typeof ContactWindow>;
export const FormOfAddress = z.enum(["VOS", "USTED"]);
export type FormOfAddress = z.infer<typeof FormOfAddress>;

/** `code` of every tool failure (docs/tool-catalog.md, Convenciones). */
export const ErrorCode = z.enum([
  "NOT_FOUND",
  "FORBIDDEN",
  "INVALID",
  "CONFLICT",
  "UNAVAILABLE",
  "NOT_IDENTIFIED",
  "COMPLAINT_REQUIRED",
  "EVIDENCE_REQUIRED",
  "ABOVE_CAP",
  "NOT_ELIGIBLE",
  "POLICY_DENIED",
  "DEFERRED",
  "CONTROL_OPERATOR",
  "TEMPLATE_REQUIRED",
  "TEMPLATE_PARAM_NOT_ALLOWED",
  "RECIPIENT_NOT_ALLOWED",
  "GROUNDING_FAIL",
  "UNKNOWN_DELIVERY",
  "TURN_CAP",
  "AGENT_KILLED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
export type Weekday = z.infer<typeof Weekday>;
