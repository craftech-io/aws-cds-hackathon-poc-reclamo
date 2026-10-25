// Which outcome an agent's resolution may record (CLAUDE.md "the final classification of the register is
// code", ADR-0005). The model names the outcome; the code checks it against what the case file proves:
//
//   - an executed money action (a payment applied, a charge reversed, a duplicate refunded, a transfer
//     reversed) gave the customer what they claimed: IN_FAVOUR or PARTIALLY_IN_FAVOUR;
//   - a money complaint (a payment, a charge, a duplicate debit, a transfer, a disbursement) without one
//     found nothing to give back (ALREADY_APPLIED, CORRECT, NOT_DUPLICATE, COMPLETED, PAID): NOT_IN_FAVOUR
//     or INFORMATIONAL;
//   - any other type (a certificate, a closure, a data change, an information request) is not decided by
//     money: every outcome but WITHDRAWN, which only the withdrawal records.
//
// An operator resolving a human case decides by themselves; this check is for the agent's tools.
import { type ComplaintOutcome, type ComplaintType, ToolError } from "@reclamo/shared";
import type { Action, ActionKind } from "../domain/case-items";

const MONEY_ACTIONS: ReadonlySet<ActionKind> = new Set(["APPLY_PAYMENT", "REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"]);

const MONEY_TYPES: ReadonlySet<ComplaintType> = new Set(["PAYMENT_NOT_REFLECTED", "UNRECOGNIZED_CHARGE", "DUPLICATE_DEBIT", "TRANSFER_NOT_CREDITED", "DISBURSEMENT_NOT_RECEIVED"]);

const GAVE_BACK: readonly ComplaintOutcome[] = ["IN_FAVOUR", "PARTIALLY_IN_FAVOUR"];
const NOTHING_TO_GIVE_BACK: readonly ComplaintOutcome[] = ["NOT_IN_FAVOUR", "INFORMATIONAL"];
const NOT_BY_MONEY: readonly ComplaintOutcome[] = [...GAVE_BACK, ...NOTHING_TO_GIVE_BACK];

/** The outcomes the case file allows an agent to record on a complaint of this type. */
export function allowedOutcomes(type: ComplaintType, actions: readonly Pick<Action, "kind" | "status">[]): readonly ComplaintOutcome[] {
  if (actions.some((action) => MONEY_ACTIONS.has(action.kind) && action.status === "EXECUTED")) return GAVE_BACK;
  return MONEY_TYPES.has(type) ? NOTHING_TO_GIVE_BACK : NOT_BY_MONEY;
}

/** `OUTCOME_MISMATCH` when the asked outcome is not one the case file allows. */
export function checkOutcome(type: ComplaintType, actions: readonly Pick<Action, "kind" | "status">[], outcome: ComplaintOutcome): void {
  const allowed = allowedOutcomes(type, actions);
  if (allowed.includes(outcome)) return;
  const why = allowed === GAVE_BACK ? "an executed money action gave the customer what they claimed" : "no money action was executed on this complaint";
  throw new ToolError("INVALID", `outcome ${outcome} does not match the case: ${why}; use ${allowed.join(" or ")}`, "OUTCOME_MISMATCH");
}
