// The product terms and the fee schedule of the fictitious lender as `get_terms` and `get_fee_rules`
// read them from `Reference` (docs/seed-spec.md §3, ADR-0008: no knowledge base, short synthetic
// documents versioned in a table, read deterministically):
//
//   REF#TERMS#<version>   one row per clause, sort key = clause id   {id, topic, text}
//   REF#FEES#<version>    one row per fee, sort key = fee code        {code, concept, base, when, clauseIds}
//
// The row shapes are the seed's own (scripts/seed/generate/terms.ts), so `seed:load` writes them as
// generated. What a topic covers is decided here, by clause id, never by the model.
import { ClauseId, FeeCode } from "@reclamo/core-contract";
import { z } from "zod";
import { STAFF_TEXT } from "../../copy";
import type { Connector } from "../../connector/port";
import type { ToolInput } from "../common/define";
import type { ACCOUNT_TOOLS } from "./schema";

/** Versions in force (`Reference/TERMS#v001`, `Reference/FEES#v001`). */
export const TERMS_VERSION = "v001";
export const FEE_SCHEDULE_VERSION = "v001";

export const TERMS_REFERENCE = { type: "TERMS", scope: TERMS_VERSION } as const;
export const FEES_REFERENCE = { type: "FEES", scope: FEE_SCHEDULE_VERSION } as const;

export const ClauseRecord = z.object({ id: ClauseId, topic: z.string().min(1).max(60), text: z.string().min(1).max(600) });
export type ClauseRecord = z.infer<typeof ClauseRecord>;

export const FeeRecord = z.object({
  code: FeeCode,
  concept: z.string().min(1).max(80),
  base: z.string().min(1).max(160),
  when: z.string().min(1).max(160),
  clauseIds: z.array(ClauseId).max(8),
});
export type FeeRecord = z.infer<typeof FeeRecord>;

/** The topics `get_terms` accepts (its schema is the only source of the enum). */
export type TermsTopic = NonNullable<ToolInput<(typeof ACCOUNT_TOOLS)["get_terms"]>["topic"]>;

/** The clauses of each topic, at most 8 each (the tool's limit), in the order they are returned. */
export const TOPIC_CLAUSES: Readonly<Record<TermsTopic, readonly string[]>> = {
  LOANS: ["T-1.1", "T-1.2", "T-1.3", "T-1.4", "T-1.5", "T-1.6", "T-2.1", "T-2.2"],
  PAYMENTS: ["T-2.1", "T-2.2", "T-2.3", "T-2.4", "T-2.5", "T-3.4", "T-5.1"],
  LATE_INTEREST: ["T-3.1", "T-3.2", "T-3.3", "T-3.4", "T-3.5", "T-2.5"],
  WALLET: ["T-4.1", "T-4.2", "T-4.3", "T-4.4", "T-4.5", "T-4.6"],
  AUTO_DEBIT: ["T-5.1", "T-5.2", "T-5.3", "T-5.4"],
  TRANSFERS: ["T-2.1", "T-4.2", "T-4.3", "T-4.4", "T-4.5"],
  EARLY_PAYOFF: ["T-6.1", "T-6.2", "T-6.3", "T-6.4"],
  CLOSURE: ["T-7.1", "T-7.2", "T-7.3", "T-7.4"],
  FEES: ["T-1.5", "T-1.6", "T-3.2", "T-3.4", "T-4.6", "T-6.2"],
  COMPLAINT_RIGHTS: ["D-1", "D-2", "D-3", "D-4", "D-5"],
  DATA_PROTECTION: ["P-1", "P-2", "P-3", "T-3.5", "T-8.1", "T-8.2", "T-8.3"],
};

/** Labels every clause carries, so the model says what it is quoting (CLAUDE.md "Supuestos rotulados"). */
export const CLAUSE_LABEL = {
  SYNTHETIC: STAFF_TEXT.SYNTHETIC_TERMS,
  RIGHTS: STAFF_TEXT.NOT_LEGAL_ADVICE,
} as const;

/** The rights of the complaint (`D-*`) are our reading of the rules; every other clause is synthetic. */
export function clauseLabel(clauseId: string): string {
  return clauseId.startsWith("D-") ? CLAUSE_LABEL.RIGHTS : CLAUSE_LABEL.SYNTHETIC;
}

export async function readClauses(connector: Pick<Connector, "reference">): Promise<ClauseRecord[]> {
  return connector.reference.list(ClauseRecord, TERMS_REFERENCE.type, TERMS_REFERENCE.scope);
}

export async function readFees(connector: Pick<Connector, "reference">): Promise<FeeRecord[]> {
  return connector.reference.list(FeeRecord, FEES_REFERENCE.type, FEES_REFERENCE.scope);
}
