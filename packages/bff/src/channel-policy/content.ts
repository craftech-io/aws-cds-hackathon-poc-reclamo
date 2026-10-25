// The content rules (docs/design-brief.md §7) over the free text and the rendered template body of a
// request: collection and payment requests by WhatsApp, credit offers on any channel, requests for
// sensitive data and foreign contacts. outbound/verify.ts runs the same readers again on the final
// rendered text (step 4 of the gate); here they decide before anything is rendered. A past send
// re-checked (`AS_OF`) reads its stored, masked body for collection, payment requests and offers; the
// sensitive-data and foreign-contact rules only run when the message is sent (masking hides what
// they look for).
import { renderTemplateBody } from "../copy/templates";
import type { CollectionCategory } from "../copy/types";
import { block, pass, skip } from "./checks";
import { classifyCollection } from "./collection-lexicon";
import { creditOfferFindings, foreignContactFindings, sensitiveFindings } from "./content-lexicons";
import type { PolicyContext } from "./context";
import { COLLECTION_KINDS } from "./kinds";
import type { RuleCheck } from "./types";

/** Categories `CH-WA-NO-COLLECTION` blocks on; `PAYMENT_INSTRUMENT` is `CH-WA-NO-PAYMENT-REQUEST`'s. */
const COLLECTION_RULE_CATEGORIES: ReadonlySet<CollectionCategory> = new Set(["PAYMENT_EXHORTATION", "CONSEQUENCE_THREAT", "DEBT_REMINDER", "NEGOTIATION"]);

/** How the author rewrites a text a collection category stopped: a hint for the rewrite, never the matched words. */
const COLLECTION_HINT: Readonly<Record<CollectionCategory, string>> = {
  PAYMENT_EXHORTATION: "never ask for, urge or suggest a payment",
  CONSEQUENCE_THREAT: "never mention what happens if the customer does not pay",
  DEBT_REMINDER: "describe an instalment or a loan only by its number, due date, amount and the statusText a tool returned; never call it overdue, unpaid, late, in arrears or a debt",
  PAYMENT_INSTRUMENT: "never invite the customer to pay nor hand over a link, code, CVU or alias to pay; a question about where instalments are paid is answered with the clause as written, impersonal (\"las cuotas se pagan en…\"), never as an invitation (\"podés pagar…\")",
  NEGOTIATION: "never mention payment plans, refinancing, reductions or discounts",
};

export function collectionHintOf(categories: readonly CollectionCategory[]): string {
  return categories.map((category) => COLLECTION_HINT[category]).join("; ");
}

/** The texts a customer would read: the free text and the template body (when its parameters are valid). */
export function textsOf(ctx: PolicyContext): string[] {
  const { text, template } = ctx.request;
  const texts = text === undefined || text.trim() === "" ? [] : [text];
  if (template !== undefined) {
    try {
      texts.push(renderTemplateBody(template.name, template.params));
    } catch {
      // An invalid template never goes out: CH-WA-24H blocks it with TEMPLATE_PARAM_NOT_ALLOWED.
      texts.push(...template.params);
    }
  }
  return texts;
}

function collectionCategories(ctx: PolicyContext): CollectionCategory[] {
  return [...new Set(textsOf(ctx).flatMap((text) => classifyCollection(text).categories))];
}

/** `CH-WA-NO-COLLECTION`: by WhatsApp no collection, from any sender: a `COLLECTION_*` kind or a text the lexicon reads as collection. */
export function checkNoCollection(ctx: PolicyContext): RuleCheck {
  if (!ctx.byWhatsApp) return skip("the collection rule applies to WhatsApp; the formal debt notice by email is the allowed path");
  const { kind } = ctx.request;
  if (COLLECTION_KINDS.has(kind)) return block(`${kind} is collection: never by WhatsApp, whoever sends it`);
  const categories = collectionCategories(ctx).filter((category) => COLLECTION_RULE_CATEGORIES.has(category));
  if (categories.length > 0) return block(`the text reads as collection (${categories.join(", ")}): never by WhatsApp; ${collectionHintOf(categories)}`, undefined, categories);
  return pass("no collection in the text");
}

/** `CH-WA-NO-PAYMENT-REQUEST`: by WhatsApp no payment request, link or payment instrument. */
export function checkNoPaymentRequest(ctx: PolicyContext): RuleCheck {
  if (!ctx.byWhatsApp) return skip("the payment-request rule applies to WhatsApp");
  if (collectionCategories(ctx).includes("PAYMENT_INSTRUMENT")) return block(`the text asks for a payment or carries a way to pay: ${collectionHintOf(["PAYMENT_INSTRUMENT"])}`, undefined, ["PAYMENT_INSTRUMENT"]);
  return pass("no payment request in the text");
}

/** `CH-NO-CREDIT-OFFER`: no channel carries credit offers, refinancing or limit raises. */
export function checkNoCreditOffer(ctx: PolicyContext): RuleCheck {
  const findings = textsOf(ctx).flatMap(creditOfferFindings);
  if (findings.length > 0) return block(`the text offers credit (${[...new Set(findings)].join(", ")})`);
  return pass("no credit offer in the text");
}

/** `CH-NO-SENSITIVE-ASK`: no text asks for (or carries) passwords, PINs, codes, cards, bank data or documents. */
export function checkNoSensitiveAsk(ctx: PolicyContext): RuleCheck {
  if (ctx.mode === "AS_OF") return skip("sensitive data is checked when the message is sent; the stored body is masked");
  const findings = textsOf(ctx).flatMap(sensitiveFindings);
  if (findings.length > 0) return block(`the text asks for or carries sensitive data (${[...new Set(findings)].join(", ")})`);
  return pass("the text asks for no password, code, card, bank data or document");
}

/** `CH-NO-FOREIGN-LINKS`: no links, domains, emails or phones but the stage's and masked records. */
export function checkNoForeignLinks(ctx: PolicyContext): RuleCheck {
  if (ctx.mode === "AS_OF") return skip("contacts are checked when the message is sent; the stored body is masked");
  const findings = textsOf(ctx).flatMap((text) => foreignContactFindings(text, ctx.settings.stageDomains));
  if (findings.length > 0) return block(`the text carries a contact that is not the stage's (${[...new Set(findings)].join(", ")})`);
  return pass("no link or contact outside the stage");
}
