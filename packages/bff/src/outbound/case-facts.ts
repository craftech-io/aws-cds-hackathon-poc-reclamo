// What the complaint a message is about already proved, as the agent's text may quote it in a later turn
// (docs/architecture-integrations.md §4 step 4): the outbound verification grounds the figures of a text
// against this turn's tool results AND these facts, so a written answer sent on an `APPROVAL_DECIDED` or
// `ANSWER_DUE` turn can cite the reading, the match and the executed action of earlier turns. Only what
// code validated and what is this customer's own enters:
//
//   readings     a `READ` (or `DUPLICATE_OF`) receipt reading: its validated fields; never a reading that
//                failed validation or a disagreement (the image is hostile content)
//   matches      a `MATCHED` settlement line (a match is the customer's own line); never the line of a
//                `PAYER_MISMATCH`, which never leaves
//   actions      the core's reference and the amount of every action on the complaint
//   approvals    the amount of every approval request
//
// Amounts go out as the tools write them ("$ 312.400,00"), so the verifier compares them as a reader sees them.
import { pesosFromCents } from "@reclamo/shared";
import type { CaseFile } from "../connector/repos/case-items";
import type { JsonObject } from "../domain/common";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function amountText(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? pesosFromCents(value).text : undefined;
}

function compact(entries: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

const VALID_READINGS = new Set(["READ", "DUPLICATE_OF"]);

/** The grounding facts of a complaint's case file; empty when it proved nothing yet. */
export function caseFactsOf(file: Pick<CaseFile, "evidence" | "actions" | "approvals">): JsonObject[] {
  const readings = file.evidence.flatMap((item) => {
    const fields = item.kind === "RECEIPT_READING" && VALID_READINGS.has(String(item.details["result"])) ? record(item.details["fields"]) : undefined;
    return fields === undefined ? [] : [compact({ operationCode: text(fields["operationCode"]), amount: amountText(fields["amount"]) })];
  });
  const matches = file.evidence.flatMap((item) => {
    const line = item.kind === "SETTLEMENT_MATCH" && item.details["result"] === "MATCHED" ? record(item.details["line"]) : undefined;
    return line === undefined ? [] : [compact({ operationCode: text(line["operationCode"]), amount: amountText(line["amount"]) })];
  });
  const actions = file.actions.map((action) => compact({ coreRef: action.coreRef, amount: amountText(action.amountCents) }));
  const approvals = file.approvals.map((approval) => compact({ amount: amountText(approval.amountCents) }));
  const facts = { readings, matches, actions, approvals };
  return Object.values(facts).some((list) => list.length > 0) ? [{ caseFile: facts }] : [];
}
