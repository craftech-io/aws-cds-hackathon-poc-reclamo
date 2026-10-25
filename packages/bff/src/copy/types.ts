// Types shared by every file of copy/. The whole directory is pure data plus string helpers: it
// imports only zod and @reclamo/shared, so the console (packages/web) and the seed can import it
// without pulling in Node or the AWS SDK (copy.test.ts asserts it).
import { z } from "zod";

/** A fixed text and its English gloss (docs/design-brief.md §13). */
export interface Glossed {
  readonly es: string;
  readonly en: string;
}

/**
 * Where a WhatsApp button title is rendered. The Meta Cloud API caps each form differently
 * (docs/architecture-integrations.md §3.3): an interactive reply button at 20 characters, a list
 * row and the list menu button at 24 and 20, a template `quick_reply` at 25.
 */
export const ButtonForm = z.enum(["INTERACTIVE", "LIST_ROW", "LIST_MENU", "QUICK_REPLY"]);
export type ButtonForm = z.infer<typeof ButtonForm>;

export const BUTTON_TITLE_LIMIT: Readonly<Record<ButtonForm, number>> = {
  INTERACTIVE: 20,
  LIST_ROW: 24,
  LIST_MENU: 20,
  QUICK_REPLY: 25,
};

/** The four `UTILITY` templates registered with Meta (docs/architecture-integrations.md §3.3). */
export const TemplateName = z.enum(["reclamo_novedad", "reclamo_resuelto", "reclamo_derivado", "reclamo_respuesta_no_entregada"]);
export type TemplateName = z.infer<typeof TemplateName>;

/** What each positional template parameter carries; the gate checks the value against `TURN#`. */
export const TemplateParamKind = z.enum(["FIRST_NAME", "COMPLAINT_NUMBER", "STATUS_PHRASE", "EMAIL_MASKED", "DEADLINE_TEXT"]);
export type TemplateParamKind = z.infer<typeof TemplateParamKind>;

/** Categories of an account block as the core returns them (`get_account`). */
export const AccountBlockCategory = z.enum(["SECURITY_REVIEW", "IDENTITY_VALIDATION", "EXTERNAL_ORDER", "INACTIVITY"]);
export type AccountBlockCategory = z.infer<typeof AccountBlockCategory>;

/** Fields `request_data_change` accepts. */
export const DataChangeField = z.enum(["EMAIL", "ADDRESS", "PHONE"]);
export type DataChangeField = z.infer<typeof DataChangeField>;

/** Kinds of identity challenge the core can check (`challenge-check`). */
export const ChallengeKind = z.enum(["LAST_DUE_DATE", "LAST_INSTALMENT_AMOUNT", "LAST_MOVEMENT_AMOUNT"]);
export type ChallengeKind = z.infer<typeof ChallengeKind>;

/** The channel-policy rules in the order the policy applies them (docs/design-brief.md §7). */
export const ChannelRuleId = z.enum([
  "CH-SENDER",
  "CH-CONTROL",
  "CH-KIND-CHANNEL",
  "CH-WA-NO-COLLECTION",
  "CH-WA-NO-PAYMENT-REQUEST",
  "CH-NO-CREDIT-OFFER",
  "CH-RECIPIENT-FENCE",
  "CH-OPTIN",
  "CH-OPTOUT",
  "CH-WA-CUSTOMER-INITIATED",
  "CH-WA-24H",
  "CH-CONTACT-HOURS",
  "CH-MAX-PER-DAY",
  "CH-NO-SENSITIVE-ASK",
  "CH-NO-FOREIGN-LINKS",
  "CH-FORMAL-CONTENT",
]);
export type ChannelRuleId = z.infer<typeof ChannelRuleId>;

/** Everything that can stop a message at the gate: a `CH-*` rule, the output guardrail or the deterministic check. */
export const BlockSource = z.enum([...ChannelRuleId.options, "G2", "VERIFY"]);
export type BlockSource = z.infer<typeof BlockSource>;

/** Categories of the collection lexicon (`channel-policy/collection-lexicon.ts`), shown on the tape. */
export const CollectionCategory = z.enum(["PAYMENT_EXHORTATION", "CONSEQUENCE_THREAT", "DEBT_REMINDER", "PAYMENT_INSTRUMENT", "NEGOTIATION"]);
export type CollectionCategory = z.infer<typeof CollectionCategory>;

/** PDF documents the product emits (docs/architecture-integrations.md §8). */
export const DocKind = z.enum(["ACK", "ANSWER", "PAYOFF_CERTIFICATE", "CREDIT_NOTE", "STATEMENT", "CLOSURE", "DATA_CHANGE", "COLLECTION_NOTICE"]);
export type DocKind = z.infer<typeof DocKind>;

/** Synthetic receipt variants of the seed (docs/seed-spec.md §9). */
export const ReceiptVariant = z.enum(["legible", "blurry", "fake-check", "fake-unknown", "injection", "not-receipt", "other-payer", "tampered-chunk"]);
export type ReceiptVariant = z.infer<typeof ReceiptVariant>;

/** A loan's status as the core states it (`@reclamo/core-contract` LoanStatus): what `LOAN_STATUS_TEXT` describes. */
export type LoanStatusKey = "ACTIVE" | "IN_ARREARS" | "CANCELLED" | "EARLY_CANCELLED";
/** An instalment's status as the core states it (`@reclamo/core-contract` InstalmentStatus). */
export type InstalmentStatusKey = "DUE" | "PAID" | "PARTIALLY_PAID" | "OVERDUE";
