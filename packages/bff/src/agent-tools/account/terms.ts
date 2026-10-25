// `get_terms` and `get_fee_rules` (docs/tool-catalog.md, ADR-0008): the public clauses of the product
// and the fee schedule, read from `Reference` (reference.ts). Deterministic: the same topic or ids give
// the same clauses in the same order, at most 8, each with the label that says what it is (synthetic
// terms of a fictitious lender, or our reading of the rules for the rights of the complaint). These
// results are what G2 grounds a reply on (FL-032, FL-063); the clauses read are left as a
// `TERMS_CLAUSE` evidence on the complaint of the turn (evidence.ts).
import { ToolError, ok } from "@reclamo/shared";
import type { ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import { noteOnComplaint } from "./evidence";
import { type ClauseRecord, FEE_SCHEDULE_VERSION, TERMS_VERSION, TOPIC_CLAUSES, clauseLabel, readClauses, readFees } from "./reference";
import { MAX_CLAUSES, type ACCOUNT_TOOLS } from "./schema";

type Tools = typeof ACCOUNT_TOOLS;

/** The clause ids a call asks for: the ids it names, then its topic's, without repeats, at most 8. */
export function requestedClauseIds(input: { readonly topic?: keyof typeof TOPIC_CLAUSES | undefined; readonly clauseIds?: readonly string[] | undefined }): string[] {
  const ids = [...(input.clauseIds ?? []), ...(input.topic === undefined ? [] : TOPIC_CLAUSES[input.topic])];
  return [...new Set(ids)].slice(0, MAX_CLAUSES);
}

function clauseView(clause: ClauseRecord) {
  return { clauseId: clause.id, title: clause.topic, text: clause.text, label: clauseLabel(clause.id) };
}

export const getTerms: ToolImplementation<ToolInput<Tools["get_terms"]>> = async (ctx) => {
  const wanted = requestedClauseIds(ctx.input);
  if (wanted.length === 0) throw new ToolError("INVALID", "name a topic or the clause ids to read");
  const byId = new Map((await readClauses(ctx.connector)).map((clause) => [clause.id, clause]));
  const clauses = wanted.flatMap((id) => {
    const clause = byId.get(id);
    return clause === undefined ? [] : [clauseView(clause)];
  });
  if (clauses.length === 0) throw new ToolError("NOT_FOUND", "no clause of the product terms has those ids");
  await noteOnComplaint(ctx, "TERMS_CLAUSE", { termsVersion: TERMS_VERSION, clauseIds: clauses.map((clause) => clause.clauseId) });
  return ok({ termsVersion: TERMS_VERSION, clauses });
};

export const getFeeRules: ToolImplementation<ToolInput<Tools["get_fee_rules"]>> = async (ctx) => {
  const fees = (await readFees(ctx.connector)).filter((fee) => ctx.input.feeCode === undefined || fee.code === ctx.input.feeCode);
  if (fees.length === 0) throw new ToolError("NOT_FOUND", ctx.input.feeCode === undefined ? "the fee schedule is not available" : "no fee of the schedule has that code");
  await noteOnComplaint(ctx, "TERMS_CLAUSE", { scheduleVersion: FEE_SCHEDULE_VERSION, feeCodes: fees.map((fee) => fee.code), clauseIds: [...new Set(fees.flatMap((fee) => fee.clauseIds))] });
  return ok({
    scheduleVersion: FEE_SCHEDULE_VERSION,
    fees: fees.map((fee) => ({ feeCode: fee.code, label: fee.concept, basis: fee.base, whenApplies: fee.when, clauseIds: [...fee.clauseIds] })),
  });
};
