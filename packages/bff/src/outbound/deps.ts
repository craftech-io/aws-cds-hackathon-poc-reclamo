// What the outbound gate needs, as ports: the chains (connector, `RegisterChainKey`, anchors, real
// clock, ids, the timer scheduler), the world's simulated clock, the core's view of the customer and
// of an overdue loan, the customer's mailbox and WhatsApp number, the PDFs it attaches, G2, the single
// SES client and the WhatsApp transports. stage.ts builds them for a Lambda from its links (never
// `process.env`); tests and the local flows build them over the memory connector and fakes
// (testing.ts). Nothing here reads a machine clock for a business decision (ADR-0011).
import type { CalendarDate } from "@reclamo/shared";
import type { EmailClient } from "../channels/email/outbound";
import type { WhatsAppTransports } from "../channels/whatsapp/registry";
import type { RecipientResolver } from "../channels/whatsapp/transport";
import type { ComplaintsDeps } from "../complaints/deps";
import type { ChannelModes } from "../lib/resource";
import type { OutputGuardrail } from "./g2";
import type { OutboundAttachment } from "./types";

/** The customer as the core shows it (masked): what the policy, the render and the templates read. */
export interface CustomerFacts {
  readonly customerId: string;
  readonly firstName: string;
  readonly emailMasked: string;
  readonly whatsapp: {
    readonly optedIn: boolean;
    readonly optedInAtSim?: string | undefined;
    readonly optInMedium?: string | undefined;
    readonly optInTextVersion?: string | undefined;
    readonly optedOut: boolean;
    readonly optedOutAtSim?: string | undefined;
  };
  /** Loans as list rows of a `CHOOSE_LOAN` question. */
  readonly loans: readonly { readonly loanId: string; readonly label: string }[];
}

/** `GET /customers/{customerId}` of the core, at the world's simulated instant. */
export interface CustomerReader {
  get(worldId: string, customerId: string, simNow: Date, correlationId: string): Promise<CustomerFacts | undefined>;
}

/** The customer's mailbox in clear (PII: fenced, never logged nor stored outside the `.eml`). */
export interface EmailDirectory {
  addressOf(worldId: string, customer: CustomerFacts): Promise<string | undefined>;
}

/** The overdue instalments of a customer's loan, from the core: the only source of a formal debt notice. */
export interface DebtDetail {
  readonly loanId: string;
  readonly loanLabel: string;
  readonly overdue: readonly { readonly instalment: number; readonly dueDate: CalendarDate; readonly amountCents: number }[];
  readonly totalCents: number;
}

export interface DebtReader {
  overdue(worldId: string, customerId: string, simNow: Date, correlationId: string): Promise<DebtDetail | undefined>;
}

/** A PDF of `Documents` with its bytes, ready to attach. */
export interface AttachableDocument extends OutboundAttachment {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface DocumentStore {
  /** The bytes of a PDF the caller already rendered and stored (the gate checks its SHA-256). */
  read(s3Key: string): Promise<Uint8Array>;
  /** Renders and stores the `COLLECTION_NOTICE` PDF from the core's detail (pdf/), for the formal notice. */
  collectionNotice(input: { readonly worldId: string; readonly customerId: string; readonly customerName: string; readonly debt: DebtDetail; readonly issuedAtSim: string; readonly complaintNumber?: string }): Promise<AttachableDocument>;
}

/** `SeedOverrides.demoRecipients`: honoured only from the `demo` world. */
export interface DemoRecipientList {
  readonly emails: readonly string[];
  readonly phones: readonly string[];
}

export interface OutboundDeps {
  /** Connector, `RegisterChainKey`, `AnchorWriter`, logger, real clock, ids and the timers' schedules. */
  readonly chains: ComplaintsDeps;
  /** The world's simulated "now" (lib/clock.ts `worldClock`). */
  readonly simNow: (worldId: string) => Promise<Date>;
  readonly customers: CustomerReader;
  readonly emails: EmailDirectory;
  /** The customer's WhatsApp number by mode (the live one only in a live world). */
  readonly recipients: RecipientResolver;
  /** `PhoneHashKey` subkey `phone-hash` over an E.164: what a button nonce is bound to. */
  readonly phoneHash: (phoneE164: string) => Promise<string>;
  readonly debts: DebtReader;
  readonly documents: DocumentStore;
  readonly guardrail: OutputGuardrail;
  /** The single SES client (channels/email/outbound.ts): the fence runs again inside `send`. */
  readonly email: Pick<EmailClient, "send" | "checkRecipient">;
  readonly whatsapp: WhatsAppTransports;
  /** `ChannelModes` of the stage: which worlds may ever run WhatsApp live. */
  readonly stageModes: ChannelModes;
  readonly demoRecipients: () => DemoRecipientList;
  /** Test seam for the button nonces. */
  readonly newNonce?: (nowMs: number) => string;
}
