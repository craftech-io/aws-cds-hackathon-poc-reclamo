// What a capture may show (ADR-0010, ADR-0019): before a frame is written, the text the page renders is
// checked against the operator's external list of forbidden terms and against the contest words of
// the neutral-surfaces guard. The pipeline fails closed without the list; a finding names the capture,
// the line and the term's position in the list, never the term.
import { type ForbiddenTerm, findTerms, listFromEnv } from "../lint/forbidden-terms";
import { findNeutralTerms } from "../lint/neutral-surfaces";

/** The forbidden terms of the environment; throws when the list is absent or empty. */
export function requiredTerms(env: NodeJS.ProcessEnv = process.env): readonly ForbiddenTerm[] {
  const list = listFromEnv(env);
  if (!list.ok) throw new Error("FORBIDDEN_TERMS is absent or empty: the captures are only taken with the list (fails closed)");
  return list.terms;
}

/** The problems of a frame's rendered text; empty when it can be published. */
export function frameProblems(id: string, text: string, terms: readonly ForbiddenTerm[]): string[] {
  return [
    ...findTerms(id, text, terms).map((finding) => `${id}: line ${finding.line} matches forbidden term #${finding.term}`),
    ...findNeutralTerms(id, text).map((finding) => `${id}: line ${finding.line} names "${finding.term}"`),
  ];
}
