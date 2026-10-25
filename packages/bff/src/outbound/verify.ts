// Deterministic verification of the final rendered text (docs/architecture-integrations.md §4 step 4,
// docs/design-brief.md §8): what G2 does not guarantee, run on exactly what the customer will read
// (the disclosure line, the template body as rendered, the email text):
//
//   FIGURES          every amount, and every other number of four or more digits (complaint numbers,
//                    dates, operation codes), of a text the agent wrote is in the turn's results
//                    (`Runtime/TURN#`, services/grounding.ts), in what the message's complaint already
//                    proved (outbound/case-facts.ts, passed with the results) or is the message's own
//                    complaint number or deadline; an amount spelled in words fails closed
//   PARAMS           every template parameter the agent filled is grounded by its kind
//                    (outbound/template-grounding.ts): a complaint number, a deadline, a masked email
//                    and a first name are EXACTLY a value a tool returned (or the message's complaint's
//                    number and deadline); `{{3}}` is a phrase id of the closed list
//   LANGUAGE         a text the agent or an operator wrote is Spanish (services/language.ts)
//   COLLECTION       on every WhatsApp text, whoever sends it (also SYSTEM and templates): the collection
//                    lexicon → `CH-WA-NO-COLLECTION`; a way to pay → `CH-WA-NO-PAYMENT-REQUEST`
//   CREDIT_OFFER     no channel carries a credit offer → `CH-NO-CREDIT-OFFER`
//   SENSITIVE_ASK    no text asks for passwords, codes, cards, bank data or documents → `CH-NO-SENSITIVE-ASK`
//   FOREIGN_LINKS    no link, domain, email or phone but the stage's → `CH-NO-FOREIGN-LINKS`
//
// The first three are `GROUNDING_FAIL` on the tape as `VERIFY`; the rest block with their `CH-*` rule.
// A failure's detail names checks and categories, never the text.
import type { Channel, MessageKind } from "@reclamo/shared";
import { WHATSAPP_TEMPLATES } from "../copy/templates";
import type { ChannelRuleId, CollectionCategory, TemplateName } from "../copy/types";
import { classifyCollection } from "../channel-policy/collection-lexicon";
import { collectionHintOf } from "../channel-policy/content";
import { creditOfferFindings, foreignContactFindings, sensitiveFindings } from "../channel-policy/content-lexicons";
import type { SenderClass } from "../channel-policy/kinds";
import { ungroundedFigures } from "../services/grounding";
import { detectLanguage } from "../services/language";
import { type MessageComplaint, complaintFactsOf, groundingFactsOf, templateParamGrounded } from "./template-grounding";
import { GATE_RULE } from "./types";

export type VerifyCheck = "FIGURES" | "PARAMS" | "LANGUAGE" | "COLLECTION" | "PAYMENT_REQUEST" | "CREDIT_OFFER" | "SENSITIVE_ASK" | "FOREIGN_LINKS";

export interface VerifyFailure {
  readonly check: VerifyCheck;
  /** `VERIFY` for grounding and language, the `CH-*` rule otherwise. */
  readonly ruleId: ChannelRuleId | typeof GATE_RULE.VERIFY;
  readonly code: "GROUNDING_FAIL" | "POLICY_DENIED";
  readonly detail: string;
  readonly categories?: readonly CollectionCategory[];
}

export interface VerifyInput {
  readonly channel: Channel;
  readonly kind: MessageKind;
  readonly senderClass: SenderClass;
  /** Everything the customer will read, as rendered (for an email, the text part). */
  readonly rendered: string;
  /** The words the agent or an operator wrote (absent for a template or a text of copy/). */
  readonly freeText?: string;
  /** A template the agent filled, as the caller passed its parameters. */
  readonly template?: { readonly name: TemplateName; readonly params: readonly string[] };
  /** The turn's tool results (`Runtime/TURN#…/RESULT#`, already redacted) and the complaint's case facts. */
  readonly results: readonly unknown[];
  /** The complaint the message is about: its number and deadline ground a parameter and a free text. */
  readonly complaint?: MessageComplaint;
  readonly stageDomains: readonly string[];
}

const COLLECTION_RULE_CATEGORIES: ReadonlySet<CollectionCategory> = new Set(["PAYMENT_EXHORTATION", "CONSEQUENCE_THREAT", "DEBT_REMINDER", "NEGOTIATION"]);

function groundingFailures(input: VerifyInput): VerifyFailure[] {
  if (input.senderClass !== "AGENT") return [];
  const failures: VerifyFailure[] = [];
  if (input.freeText !== undefined) {
    const grounded = [...input.results, ...complaintFactsOf(input.complaint)].map((result) => JSON.stringify(result));
    const gaps = ungroundedFigures(input.freeText, grounded);
    const missing = gaps.amounts.length + gaps.numbers.length;
    if (missing > 0) failures.push({ check: "FIGURES", ruleId: GATE_RULE.VERIFY, code: "GROUNDING_FAIL", detail: `${missing} figure(s) not in this turn's tool results: copy every amount, date and code from a tool result, or leave it out` });
    if (gaps.spelled.length > 0) failures.push({ check: "FIGURES", ruleId: GATE_RULE.VERIFY, code: "GROUNDING_FAIL", detail: "an amount written in words cannot be checked: write it as a tool returned it" });
  }
  if (input.template !== undefined) {
    const kinds = WHATSAPP_TEMPLATES[input.template.name].params;
    const facts = groundingFactsOf(input.results, input.complaint);
    const loose = input.template.params.flatMap((value, index) => {
      const kind = kinds[index];
      return kind === undefined || templateParamGrounded(kind, value, facts) ? [] : [index + 1];
    });
    if (loose.length > 0) failures.push({ check: "PARAMS", ruleId: GATE_RULE.VERIFY, code: "GROUNDING_FAIL", detail: `template parameter ${loose.join(", ")} is not a value of this turn's tool results` });
  }
  return failures;
}

function languageFailure(input: VerifyInput): VerifyFailure | undefined {
  if (input.freeText === undefined || input.senderClass === "SYSTEM") return undefined;
  if (detectLanguage(input.freeText) !== "NOT_SPANISH") return undefined;
  return { check: "LANGUAGE", ruleId: GATE_RULE.VERIFY, code: "GROUNDING_FAIL", detail: "a message to the customer is written in Spanish" };
}

function collectionFailures(input: VerifyInput): VerifyFailure[] {
  if (input.channel !== "WHATSAPP") return [];
  const categories = [...classifyCollection(input.rendered).categories];
  const failures: VerifyFailure[] = [];
  const collection = categories.filter((category) => COLLECTION_RULE_CATEGORIES.has(category));
  if (collection.length > 0) failures.push({ check: "COLLECTION", ruleId: "CH-WA-NO-COLLECTION", code: "POLICY_DENIED", detail: `the text reads as collection (${collection.join(", ")}): ${collectionHintOf(collection)}`, categories: collection });
  if (categories.includes("PAYMENT_INSTRUMENT")) failures.push({ check: "PAYMENT_REQUEST", ruleId: "CH-WA-NO-PAYMENT-REQUEST", code: "POLICY_DENIED", detail: `the text asks for a payment or carries a way to pay: ${collectionHintOf(["PAYMENT_INSTRUMENT"])}`, categories: ["PAYMENT_INSTRUMENT"] });
  return failures;
}

function contentFailures(input: VerifyInput): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const offers = creditOfferFindings(input.rendered);
  if (offers.length > 0) failures.push({ check: "CREDIT_OFFER", ruleId: "CH-NO-CREDIT-OFFER", code: "POLICY_DENIED", detail: `the text offers credit (${[...new Set(offers)].join(", ")})` });
  const sensitive = sensitiveFindings(input.rendered);
  if (sensitive.length > 0) failures.push({ check: "SENSITIVE_ASK", ruleId: "CH-NO-SENSITIVE-ASK", code: "POLICY_DENIED", detail: `the text asks for or carries sensitive data (${[...new Set(sensitive)].join(", ")})` });
  const foreign = foreignContactFindings(input.rendered, input.stageDomains);
  if (foreign.length > 0) failures.push({ check: "FOREIGN_LINKS", ruleId: "CH-NO-FOREIGN-LINKS", code: "POLICY_DENIED", detail: `the text carries a contact that is not the stage's (${foreign.join(", ")})` });
  return failures;
}

/**
 * Every failed check of a rendered message, the policy's own rules first (a collection block is what
 * the tape shows), then grounding and language; empty when it may go out.
 */
export function verifyOutbound(input: VerifyInput): VerifyFailure[] {
  const language = languageFailure(input);
  return [...collectionFailures(input), ...contentFailures(input), ...groundingFailures(input), ...(language === undefined ? [] : [language])];
}

/** The tool error of the first failure: a policy rule's `POLICY_DENIED`, or `GROUNDING_FAIL`. */
export function failureCodeOf(failures: readonly VerifyFailure[]): "GROUNDING_FAIL" | "POLICY_DENIED" {
  return failures[0]?.code ?? "GROUNDING_FAIL";
}
