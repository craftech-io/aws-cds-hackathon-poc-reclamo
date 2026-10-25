// The policy at a past instant (docs/build-plan.md WP-17, docs/architecture.md §11 `PolicyAudit`
// check b, docs/seed-spec.md invariant 10): a message that already went out, decided at its own
// `sentAtSim` (and real instant) with the rows as they are now, whose dated histories (control,
// opt-in and opt-out, complaint status, the customer's messages) rebuild what was in force then. An
// opt-out, a takeover or a closed complaint recorded after the send never makes it a breach; one in
// force when it went out always does. The WhatsApp window runs on the clock the message itself ran on.
// What only exists at send time is not re-checked (`SKIP`): the session and staff row of the sender,
// the recipient address (stored masked), the template parameters, sensitive data and foreign contacts
// (the stored body is masked) and the formal content (checked against the core when it went out).
// Nothing here reads the machine's clock.
import { type Channel, type MessageKind, type Sender, TurnTrigger } from "@reclamo/shared";
import { TemplateName } from "../copy/types";
import { type WhatsAppConsentState, consentHistoryOf } from "./consent";
import { type EvaluateOptions, evaluateIn } from "./engine";
import type { ConsentEvent, HistoryMessageInput, PolicyDecision, PolicyInput } from "./types";

/** The stored outbound message (`Conversations/MSG#`), as `PolicyAudit` reads it. */
export interface AsOfMessage {
  readonly messageId: string;
  readonly channel: Channel;
  readonly kind: MessageKind;
  readonly sender: Sender;
  /** The body as stored (normalized and masked). */
  readonly body?: string;
  /** The WhatsApp template it was sent as (`Message.templateName`). */
  readonly templateName?: string;
  readonly complaintId?: string;
  /** Simulated instant it went out. */
  readonly sentAtSim: string;
  /** Real instant it went out (the message's `createdAt`); orders steps of the same simulated instant. */
  readonly sentAtReal?: string;
  /** `false` only for a message sent by the live WhatsApp transport. */
  readonly simulated: boolean;
}

export interface AsOfFacts {
  readonly worldId: string;
  readonly customerId: string;
  readonly message: AsOfMessage;
  /** `trigger` the `ALLOWED` decision recorded: tells a reply to the customer from a proactive send. */
  readonly trigger?: string;
  /** The customer's message the send answered, when the decision recorded it. */
  readonly answers?: string;
  /** Dated consent steps, or the core's consent state they are rebuilt from. */
  readonly consent?: readonly ConsentEvent[] | WhatsAppConsentState;
  readonly conversation?: PolicyInput["conversation"];
  readonly complaint?: PolicyInput["complaint"];
  /** The customer's messages around the send (both channels; `ByCustomerSent`). */
  readonly history?: readonly HistoryMessageInput[];
  readonly settings: PolicyInput["settings"];
}

function consentOf(consent: AsOfFacts["consent"]): ConsentEvent[] | undefined {
  if (consent === undefined) return undefined;
  return Array.isArray(consent) ? [...consent] : consentHistoryOf(consent as WhatsAppConsentState);
}

/** A stored template: its name (the parameters were validated when it was sent). */
function templateOf(name: string | undefined): { name: TemplateName; params: string[] } | undefined {
  const parsed = TemplateName.safeParse(name);
  return parsed.success ? { name: parsed.data, params: [] } : undefined;
}

function triggerOf(raw: string | undefined): TurnTrigger | undefined {
  const parsed = TurnTrigger.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function asOfInput(facts: AsOfFacts): PolicyInput {
  const { message } = facts;
  const consentHistory = consentOf(facts.consent);
  const trigger = triggerOf(facts.trigger);
  const template = templateOf(message.templateName);
  return {
    request: {
      messageId: message.messageId,
      worldId: facts.worldId,
      customerId: facts.customerId,
      sender: message.sender,
      channel: message.channel,
      kind: message.kind,
      ...(message.body === undefined ? {} : { text: message.body }),
      ...(template === undefined ? {} : { template }),
      ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(facts.answers === undefined ? {} : { answers: facts.answers }),
    },
    ...(consentHistory === undefined ? {} : { customer: { customerId: facts.customerId, consentHistory } }),
    ...(facts.conversation === undefined ? {} : { conversation: facts.conversation }),
    ...(facts.complaint === undefined ? {} : { complaint: facts.complaint }),
    ...(facts.history === undefined ? {} : { history: [...facts.history] }),
    clock: { simNow: message.sentAtSim, realNow: message.sentAtReal ?? message.sentAtSim },
    // Email is always live; WhatsApp ran on the clock the message itself was sent on.
    modes: { whatsapp: message.simulated ? "simulated" : "live", email: "live" },
    settings: facts.settings,
  };
}

/** The policy at the instant `message` went out; `exhaustive` lists every rule it breached. */
export function evaluateAsOf(facts: AsOfFacts, options: EvaluateOptions = {}): PolicyDecision {
  return evaluateIn("AS_OF", asOfInput(facts), options);
}
