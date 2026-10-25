// Fixtures for the policy tests and for the modules that call the engine (the gate, PolicyAudit, the
// local flows): the demo world on Wednesday 07/10/2026 10:10 in Buenos Aires (docs/seed-spec.md),
// Valeria Quiroga (C01, the main story, complaint R-2026-000001), Martín Olmedo (C09, the overdue
// instalment of the collection attempt) and Rocío Gutiérrez (C38, without WhatsApp opt-in), all
// fictitious. Every instant is explicit: tests never depend on the machine's clock. Addresses are the
// SES mailbox simulator's.
import type { MessageKind } from "@reclamo/shared";
import type { HistoryMessageInput, PolicyInput, PolicyRequestInput } from "./types";

export const DEMO_NOW = "2026-10-07T10:10:00-03:00";
export const REAL_NOW = "2026-10-06T15:00:00.000Z";
/** Argentine national holidays of the seed around the story (docs/seed-spec.md §11). */
export const HOLIDAYS = ["2026-10-12", "2026-11-23", "2026-12-08", "2026-12-25"];
export const SEEDED_OPT_IN = "2025-03-01T10:00:00-03:00";
export const OPERATOR = "OPERATOR:stf-operator-01";
export const OPERATOR_STAFF = { worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", active: true } as const;

export const VALERIA = "cus-0001";
export const MARTIN = "cus-0009";
export const ROCIO = "cus-0038";
export const VALERIA_COMPLAINT = "cmp-0001";

export const SETTINGS = {
  contactHours: { weekday: { from: "08:00", to: "20:00" }, saturday: { from: "09:00", to: "13:00" }, formalNotice: { from: "09:00", to: "18:00" } },
  maxProactivePerDay: 3,
  holidays: HOLIDAYS,
  demoRecipients: { emails: ["demo.recipient@craftech.io"], phones: ["+5491100009999"] },
} satisfies PolicyInput["settings"];

export function optedIn(customerId: string): NonNullable<PolicyInput["customer"]> {
  return { customerId, consentHistory: [{ action: "OPT_IN", atSim: SEEDED_OPT_IN, medium: "SIGNED_ONBOARDING", textVersion: "v001" }], optedIn: true, optedOut: false };
}

export function withoutOptIn(customerId: string): NonNullable<PolicyInput["customer"]> {
  return { customerId, consentHistory: [], optedIn: false, optedOut: false };
}

export function optedOutAt(customerId: string, atSim: string, atReal?: string): NonNullable<PolicyInput["customer"]> {
  const base = optedIn(customerId);
  return { ...base, consentHistory: [...base.consentHistory, { action: "OPT_OUT", atSim, ...(atReal === undefined ? {} : { atReal }) }], optedOut: true };
}

export const AGENT_HOLDS: NonNullable<PolicyInput["conversation"]> = { control: "AGENT", controlHistory: [] };

export function takenAt(atSim: string, by = OPERATOR, atReal?: string): NonNullable<PolicyInput["conversation"]> {
  return { control: "OPERATOR", controlledBy: by.slice("OPERATOR:".length), controlHistory: [{ from: "AGENT", to: "OPERATOR", atSim, by, ...(atReal === undefined ? {} : { atReal }) }] };
}

export function complaintOf(customerId: string, overrides: Partial<NonNullable<PolicyInput["complaint"]>> = {}): NonNullable<PolicyInput["complaint"]> {
  return {
    complaintId: customerId === VALERIA ? VALERIA_COMPLAINT : `cmp-${customerId.slice(4)}`,
    customerId,
    complaintNumber: customerId === VALERIA ? "R-2026-000001" : "R-2026-000002",
    type: "PAYMENT_NOT_REFLECTED",
    status: "INVESTIGATING",
    filedAtSim: "2026-10-07T10:05:00-03:00",
    statusHistory: [
      { from: null, to: "REGISTERED", atSim: "2026-10-07T10:05:00-03:00" },
      { from: "REGISTERED", to: "INVESTIGATING", atSim: "2026-10-07T10:07:00-03:00" },
    ],
    ...overrides,
  };
}

/** A WhatsApp message of the customer (it opens the 24-hour window). */
export function inbound(messageId: string, atSim: string, atReal: string = REAL_NOW): HistoryMessageInput {
  return { messageId, direction: "IN", channel: "WHATSAPP", status: "RECEIVED", atSim, atReal };
}

export interface SentOptions {
  readonly channel?: "WHATSAPP" | "EMAIL";
  readonly status?: HistoryMessageInput["status"];
  readonly atReal?: string;
  readonly proactive?: boolean;
  readonly templateName?: string;
}

/** A message that went out to the customer. */
export function sent(messageId: string, kind: MessageKind, atSim: string, options: SentOptions = {}): HistoryMessageInput {
  return {
    messageId,
    direction: "OUT",
    channel: options.channel ?? "WHATSAPP",
    kind,
    status: options.status ?? "SENT",
    atSim,
    atReal: options.atReal ?? REAL_NOW,
    ...(options.proactive === undefined ? {} : { proactive: options.proactive }),
    ...(options.templateName === undefined ? {} : { templateName: options.templateName }),
  };
}

export interface InputOverrides extends Partial<Omit<PolicyInput, "request" | "clock">> {
  readonly request?: Partial<PolicyRequestInput>;
  /** Simulated instant of the send. */
  readonly at?: string;
  /** Real instant of the send. */
  readonly realAt?: string;
}

function build(request: PolicyRequestInput, overrides: InputOverrides, defaults: Partial<PolicyInput>): PolicyInput {
  const { request: requestOverrides, at, realAt, ...rest } = overrides;
  return {
    request: { ...request, ...requestOverrides },
    conversation: AGENT_HOLDS,
    history: [],
    modes: { whatsapp: "simulated", email: "live" },
    settings: SETTINGS,
    ...defaults,
    clock: { simNow: at ?? DEMO_NOW, realNow: realAt ?? REAL_NOW },
    ...rest,
  };
}

/** The agent's free-text reply to Valeria, who wrote at 10:04 (the turn her message opened). */
export function agentReply(overrides: InputOverrides = {}): PolicyInput {
  return build(
    {
      worldId: "demo",
      customerId: VALERIA,
      complaintId: VALERIA_COMPLAINT,
      sender: "AGENT",
      channel: "WHATSAPP",
      kind: "REPLY",
      text: "Encontré tu pago del 06/10 en la Red de cobro Norte; la rendición se publica el jueves 08/10 a las 08:30.",
      trigger: "CUSTOMER_MESSAGE",
      auth: { agentSessionValid: true },
    },
    overrides,
    { customer: optedIn(VALERIA), complaint: complaintOf(VALERIA), history: [inbound("msg-in-01", "2026-10-07T10:04:00-03:00")] },
  );
}

/** A proactive `reclamo_novedad` update to Valeria from `SYSTEM` (the settlement was published). */
export function proactiveUpdate(overrides: InputOverrides = {}): PolicyInput {
  return build(
    {
      worldId: "demo",
      customerId: VALERIA,
      complaintId: VALERIA_COMPLAINT,
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind: "COMPLAINT_UPDATE",
      template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000001", "SETTLEMENT_PUBLISHED"] },
      trigger: "SETTLEMENT_PUBLISHED",
    },
    overrides,
    { customer: optedIn(VALERIA), complaint: complaintOf(VALERIA) },
  );
}

/** What the operator composes on a customer's page (`console.customers.compose`), by default C09's "Recordatorio de mora". */
export function operatorCompose(overrides: InputOverrides = {}): PolicyInput {
  return build(
    { worldId: "demo", customerId: MARTIN, sender: OPERATOR, channel: "WHATSAPP", kind: "COLLECTION_REMINDER", auth: { staff: OPERATOR_STAFF } },
    overrides,
    { customer: optedIn(MARTIN) },
  );
}

/** The formal debt notice C09's blocked reminder is rerouted to (Wednesday 10:15, inside its hours). */
export function formalNotice(overrides: InputOverrides = {}): PolicyInput {
  return build(
    {
      worldId: "demo",
      customerId: MARTIN,
      sender: OPERATOR,
      channel: "EMAIL",
      kind: "COLLECTION_NOTICE_EMAIL",
      to: `success+${MARTIN}@simulator.amazonses.com`,
      rerouteOf: "tape-0001",
      auth: { staff: OPERATOR_STAFF },
      debtNotice: { source: "CORE", loanId: "L-0009", overdue: [{ instalment: 3, dueDate: "2026-09-25", amountCents: 6_421_000 }], totalCents: 6_421_000 },
    },
    { at: "2026-10-07T10:15:00-03:00", ...overrides },
    { customer: optedIn(MARTIN) },
  );
}

/** A complaint update by email to Rocío (C38), the reroute of a WhatsApp update she has no opt-in for. */
export function updateByEmail(overrides: InputOverrides = {}): PolicyInput {
  return build(
    { worldId: "demo", customerId: ROCIO, complaintId: "cmp-0038", sender: OPERATOR, channel: "EMAIL", kind: "COMPLAINT_UPDATE", to: `success+${ROCIO}@simulator.amazonses.com`, text: "Hay una novedad en tu reclamo R-2026-000002: una persona revisó tu caso.", rerouteOf: "tape-0002", auth: { staff: OPERATOR_STAFF } },
    overrides,
    { customer: withoutOptIn(ROCIO), complaint: complaintOf(ROCIO) },
  );
}
