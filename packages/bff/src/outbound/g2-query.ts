// The relevance query of G2, built by code (docs/architecture-integrations.md §4 step 3, ADR-0021
// §10): the customer's question, truncated to the query limit, or, when the customer asked nothing
// (up to three words and no "?": "hola", "ok", "gracias"), a fixed status question. Against "hola" any
// useful answer sits on the 0.5 relevance threshold and G2 refuses it; against the status question the
// short status the agent gives (ALWAYS_ANSWER) is what was asked. The thresholds do not change.

/** The fixed question a reply to small talk is scored against (infra/guardrail-policies.test.ts reads it). */
export const STATUS_QUESTION = "¿Cómo están mi cuenta y mi reclamo?";

/** The query limit of `GuardrailG2` (infra/guardrail-policies.ts `G2_LIMITS.queryMaxChars`). */
export const QUERY_MAX_CHARS = 1_000;

/** Up to this many words without a question mark is small talk, not a question. */
const SMALL_TALK_MAX_WORDS = 3;

/** Whether the customer's message asks something: a "?" or more than three words. */
export function asksSomething(text: string): boolean {
  if (text.includes("?")) return true;
  return text.split(/\s+/).filter((word) => word !== "").length > SMALL_TALK_MAX_WORDS;
}

/** The `query` qualifier of `ApplyGuardrail` for the customer's last message (absent: the status question). */
export function g2Query(customerText: string | undefined, maxChars: number = QUERY_MAX_CHARS): string {
  const asked = customerText?.trim() ?? "";
  const query = asked !== "" && asksSomething(asked) ? asked : STATUS_QUESTION;
  return query.slice(0, Math.min(maxChars, QUERY_MAX_CHARS));
}
