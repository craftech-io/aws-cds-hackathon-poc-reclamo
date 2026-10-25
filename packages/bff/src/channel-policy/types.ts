// Contract of the channel-policy engine (docs/design-brief.md §7, docs/architecture-integrations.md
// §4 step 1). Everything a rule needs arrives in `PolicyInput`
// `{request, customer, conversation, complaint, history, clock, modes, settings}`: the engine reads no
// table, no linked resource and no clock of the machine. `clock` is the instant being decided: the
// world's "now" when the gate decides a send (engine.ts `evaluate`), or the instant a stored message
// went out when `PolicyAudit` and the seed invariants look at the past (as-of.ts `evaluateAsOf`).
// Every dated fact (control, opt-in and opt-out, complaint status) is rebuilt from its history at that
// instant.
import { z } from "zod";
import {
  CalendarDate,
  Channel,
  ChannelMode,
  ComplaintNumber,
  ComplaintOutcome,
  ComplaintStatus,
  ComplaintType,
  CustomerId,
  ErrorCode,
  Id,
  IsoInstant,
  MessageKind,
  Reroute,
  Sender,
  StaffId,
  StaffRole,
  TurnTrigger,
  WorldId,
} from "@reclamo/shared";
import type { ChannelRuleId, CollectionCategory } from "../copy/types";
import { DocKind, TemplateName } from "../copy/types";
import { Actor } from "../domain/common";
import { Control } from "../domain/complaint";
import { MessageStatus } from "../domain/conversation";
import { TimeRange } from "../domain/world";

/** `SEND`: a send being decided now, failing closed on a missing fact. `AS_OF`: a past send re-checked. */
export type EvaluationMode = "SEND" | "AS_OF";

/** A `Date` or an ISO 8601 instant, read as a `Date`. */
export const PolicyInstant = z
  .union([z.date(), IsoInstant])
  .transform((value) => new Date(value instanceof Date ? value.getTime() : Date.parse(value)))
  .refine((date) => !Number.isNaN(date.getTime()), "invalid instant");

/** Who is asking to send, as the gate verified it (the policy never authenticates anything itself). */
export const PolicySenderAuth = z.object({
  /** `AGENT`: the turn's `sessionToken` verified and not expired. */
  agentSessionValid: z.boolean().optional(),
  /** `OPERATOR:<staffId>`: the staff row of the world (`Worlds/STAFF#`), never a token attribute. */
  staff: z.object({ worldId: WorldId, staffId: StaffId, role: StaffRole, active: z.boolean() }).optional(),
});

/** The formal debt notice, rendered by code from the core (docs/architecture-integrations.md §4). */
export const PolicyDebtNotice = z.object({
  source: z.literal("CORE"),
  loanId: Id,
  overdue: z.array(z.object({ instalment: z.number().int().positive(), dueDate: CalendarDate, amountCents: z.number().int().positive() })).min(1).max(24),
  totalCents: z.number().int().positive(),
});

/** The message being decided. Ids come from the session and the stores, never from the model. */
export const PolicyRequest = z.object({
  /** Its id when it already exists (a deferred send, a stored message): never counted against itself. */
  messageId: Id.optional(),
  worldId: WorldId,
  customerId: CustomerId,
  complaintId: Id.optional(),
  sender: Sender,
  channel: Channel,
  kind: MessageKind,
  /** Free text (agent draft, operator text); absent for a template or a message rendered only by code. */
  text: z.string().max(20_000).optional(),
  /** A WhatsApp template: `params` as the caller passes them (`STATUS_PHRASE` as a phrase id). */
  template: z.object({ name: TemplateName, params: z.array(z.string().max(300)).max(10) }).optional(),
  attachments: z.array(DocKind).max(5).optional(),
  /** Recipient as it will be delivered: the email address, or the live E.164 for WhatsApp `live`. */
  to: z.string().min(1).max(320).optional(),
  cc: z.array(z.string().max(320)).max(10).optional(),
  bcc: z.array(z.string().max(320)).max(10).optional(),
  /** Trigger of the turn (or of the deterministic handler) that produced the send. */
  trigger: TurnTrigger.optional(),
  /** The customer's inbound message this send answers, when the caller knows it. */
  answers: Id.optional(),
  /** Tape id of the blocked decision this request reroutes (docs/architecture-integrations.md §4). */
  rerouteOf: Id.optional(),
  auth: PolicySenderAuth.optional(),
  /** `FORMAL_ANSWER`: the resolution the code decided. */
  formal: z.object({ outcome: ComplaintOutcome }).optional(),
  /** `COLLECTION_NOTICE_EMAIL`: the debt detail read from the core. */
  debtNotice: PolicyDebtNotice.optional(),
});
export type PolicyRequestInput = z.input<typeof PolicyRequest>;

/** One step of the customer's WhatsApp consent; `atReal` orders steps of the same simulated instant. */
export const ConsentEvent = z.object({
  action: z.enum(["OPT_IN", "OPT_OUT"]),
  atSim: IsoInstant,
  atReal: IsoInstant.optional(),
  medium: z.string().max(40).optional(),
  textVersion: z.string().max(40).optional(),
});
export type ConsentEvent = z.infer<typeof ConsentEvent>;

export const PolicyCustomer = z.object({
  customerId: CustomerId,
  /** Dated opt-in and opt-out history (empty when the customer never opted in). */
  consentHistory: z.array(ConsentEvent),
  /** Current values: a send decided now also honours them (the stricter of current and dated). */
  optedIn: z.boolean().optional(),
  optedOut: z.boolean().optional(),
});

export const PolicyControlChange = z.object({ from: Control, to: Control, atSim: IsoInstant, atReal: IsoInstant.optional(), by: Actor });

export const PolicyConversation = z.object({
  control: Control,
  controlledBy: StaffId.optional(),
  controlHistory: z.array(PolicyControlChange),
});

export const PolicyStatusChange = z.object({ from: ComplaintStatus.nullable(), to: ComplaintStatus, atSim: IsoInstant, atReal: IsoInstant.optional() });

export const PolicyComplaint = z.object({
  complaintId: Id,
  customerId: CustomerId,
  complaintNumber: ComplaintNumber,
  type: ComplaintType,
  status: ComplaintStatus,
  filedAtSim: IsoInstant,
  statusHistory: z.array(PolicyStatusChange),
});

/** A message of the same customer (any complaint, both channels): what the window and the caps read. */
export const HistoryMessage = z.object({
  messageId: Id,
  direction: z.enum(["IN", "OUT"]),
  channel: Channel,
  kind: MessageKind.optional(),
  status: MessageStatus,
  templateName: z.string().max(80).optional(),
  /** The decision that let it out said it was proactive (`PolicyDecision.reply === false`). */
  proactive: z.boolean().optional(),
  atSim: IsoInstant,
  atReal: IsoInstant.optional(),
});
export type HistoryMessage = z.output<typeof HistoryMessage>;
export type HistoryMessageInput = z.input<typeof HistoryMessage>;

/** The instant being decided, in the world's simulated time and in real time. */
export const PolicyClock = z.object({ simNow: PolicyInstant, realNow: PolicyInstant });

/** The world's channel modes (`SETTINGS.channelModes`); email is always `live` (outbound only). */
export const PolicyModes = z.object({ whatsapp: ChannelMode, email: ChannelMode.default("live") });

/** The stage domain: the only domain a customer text may name (`CH-NO-FOREIGN-LINKS`). */
export const STAGE_DOMAIN = "reclamo.demo.craftech.io";

/** World settings the rules read (`Worlds/SETTINGS`), the holidays of `Reference` and the demo recipients. */
export const PolicySettings = z.object({
  contactHours: z.object({ weekday: TimeRange, saturday: TimeRange.nullable(), formalNotice: TimeRange }),
  maxProactivePerDay: z.number().int().nonnegative(),
  /** Days between two formal debt notices to the same customer. */
  formalNoticeEveryDays: z.number().int().positive().default(7),
  /** Argentine holidays (`Reference/HOLIDAY#AR`). */
  holidays: z.array(CalendarDate),
  /** `SeedOverrides.demoRecipients`: honoured only from the `demo` world. */
  demoRecipients: z.object({ emails: z.array(z.string().max(320)).max(5), phones: z.array(z.string().max(32)).max(5) }).default({ emails: [], phones: [] }),
  stageDomains: z.array(z.string().min(3).max(253)).min(1).default([STAGE_DOMAIN]),
});

export const PolicyInput = z.object({
  request: PolicyRequest,
  customer: PolicyCustomer.optional(),
  conversation: PolicyConversation.optional(),
  complaint: PolicyComplaint.optional(),
  /** The customer's messages around the instant; required to decide the window and the daily cap. */
  history: z.array(HistoryMessage).optional(),
  clock: PolicyClock,
  modes: PolicyModes,
  settings: PolicySettings,
});
export type PolicyInput = z.input<typeof PolicyInput>;
export type ParsedPolicyInput = z.output<typeof PolicyInput>;

export type RuleResult = "PASS" | "BLOCK" | "DEFER" | "SKIP";

/** Tool error code of a block (docs/tool-catalog.md, Convenciones). */
export type PolicyErrorCode = Extract<ErrorCode, "POLICY_DENIED" | "DEFERRED" | "CONTROL_OPERATOR" | "TEMPLATE_REQUIRED" | "TEMPLATE_PARAM_NOT_ALLOWED" | "RECIPIENT_NOT_ALLOWED">;

/** One rule's result for one message; `next` only on a deferral, `errorCode` only on a block that has its own. */
export interface RuleCheck {
  readonly result: RuleResult;
  readonly detail: string;
  readonly next?: Date;
  readonly errorCode?: PolicyErrorCode;
  readonly categories?: readonly CollectionCategory[];
}

/** One entry of `evaluated`: what the compliance tape keeps (`TapeEntry.evaluated`, plus the detail). */
export interface RuleEvaluation {
  readonly ruleId: ChannelRuleId;
  readonly result: RuleResult;
  readonly detail: string;
}

/** `FORMAL_EMAIL` says what the email would be: the formal debt notice or the complaint update by email. */
export type RerouteOption = { readonly route: Extract<Reroute, "HUMAN_QUEUE"> } | { readonly route: Extract<Reroute, "FORMAL_EMAIL">; readonly previewKind: "COLLECTION_NOTICE_EMAIL" | "COMPLAINT_UPDATE_EMAIL" };

export interface WindowState {
  readonly state: "OPEN" | "CLOSED";
  /** Last WhatsApp message of the customer at or before the instant. */
  readonly lastInboundAt?: string;
  readonly closesAt?: string;
}

/** `REROUTED` is not an engine outcome: the gate records it when a person or `SYSTEM` picks a reroute. */
export type PolicyOutcome = "ALLOWED" | "BLOCKED" | "DEFERRED";

export interface PolicyDecision {
  readonly decision: PolicyOutcome;
  /** The rule that blocked (every breached rule in exhaustive mode), the rules that deferred, or every rule that passed. */
  readonly ruleIds: readonly ChannelRuleId[];
  readonly evaluated: readonly RuleEvaluation[];
  /** First instant every time rule allows the send (Argentina time, `-03:00`). */
  readonly nextAllowedAt?: string;
  readonly reroutes?: readonly RerouteOption[];
  readonly errorCode?: PolicyErrorCode;
  readonly reason?: string;
  /** Collection-lexicon categories the text tripped (shown on the tape, FL-067). */
  readonly collectionCategories?: readonly CollectionCategory[];
  /** `TapeEntry.ruleSetVersion`: the rule set and the collection lexicon that decided. */
  readonly ruleSetVersion: string;
  /** WhatsApp only: the 24-hour window at the instant. */
  readonly window?: WindowState;
  /** The send answers a WhatsApp message of the customer inside the window it opened; otherwise it is proactive. */
  readonly reply: boolean;
}
