// `check_charge` and `check_duplicate_debit` (docs/tool-catalog.md, FL-032…FL-035, FL-037…FL-039): the
// core recomputes a charge against the fee schedule in force at its date, or looks for the same
// instalment debited twice; the verdict is the core's, never the model's. Each call leaves a
// `CHARGE_CHECK` or `DUPLICATE_CHECK` evidence whose id (`chargeCheckId`, `duplicateCheckId`) is what
// `reverse_charge` and `refund_duplicate_debit` need (`LAM-EVIDENCE`). A charge already reversed says so
// (`alreadyReversed`, with its credit note and date): its verdict still explains it, nothing moves again.
import { ToolError, ok } from "@reclamo/shared";
import type { ChargeCheckReason } from "@reclamo/core-contract";
import type { ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import { type CorePort, coreContextOf } from "../account/core";
import { alreadyReversedView, dayTimeText, money } from "../account/format";
import { complaintOf, recordEvidence } from "./evidence";
import type { INVESTIGATION_TOOLS } from "./schema";

type Tools = typeof INVESTIGATION_TOOLS;

/** What the core's reason means, for the model (data; the customer reads what the agent drafts). */
export const CHARGE_REASON_TEXT: Readonly<Record<ChargeCheckReason, string>> = {
  MATCHES_SCHEDULE: "The amount matches the fee schedule in force at the charge date.",
  NOT_REQUESTED: "The fee applies only to a service the customer asked for, and there is no such request.",
  NOT_CHARGEABLE: "The terms say this fee is never charged to the customer, or not in this case.",
  DUPLICATED: "The same fee was already charged for the same concept.",
  AMOUNT_DIFFERS: "The amount charged differs from what the fee schedule gives.",
  WITHIN_TOLERANCE: "The payment was made within the tolerance of the terms: the late interest does not apply.",
  NO_RULE: "The fee schedule has no rule to recompute this charge: a person must review it.",
};

/** The customer's loan when they have exactly one; otherwise the model must name it. */
async function onlyLoanOf(core: CorePort, ctx: Parameters<ToolImplementation<unknown>>[0]): Promise<string> {
  const customer = await core().call("getCustomer", coreContextOf(ctx), { params: { customerId: ctx.session.customerId } });
  const [only, ...rest] = customer.loans;
  if (only === undefined || rest.length > 0) throw new ToolError("INVALID", "loanId is required: copy it from get_account");
  return only.loanId;
}

export function checkTools(core: CorePort) {
  const checkCharge: ToolImplementation<ToolInput<Tools["check_charge"]>> = async (ctx) => {
    const complaint = complaintOf(ctx);
    const check = await core().call("checkCharge", coreContextOf(ctx), { params: { chargeId: ctx.input.chargeId } });
    if (check.customerId !== ctx.session.customerId) throw new ToolError("FORBIDDEN", "chargeId is not a charge of this customer");
    const recorded = await recordEvidence(
      ctx,
      "CHARGE_CHECK",
      {
        chargeId: check.chargeId,
        verdict: check.verdict,
        charged: check.charged,
        expectedAmount: check.expectedAmount,
        feeCode: check.feeCode,
        clauseIds: [...check.clauseIds],
        reason: check.reason,
        scheduleVersion: check.scheduleVersion,
        chargedAtSim: check.chargedAtSim,
        ...(check.loanId === undefined ? {} : { loanId: check.loanId }),
        ...(check.reversal === undefined ? {} : { reversedCreditNoteId: check.reversal.creditNoteId, reversedAtSim: check.reversal.creditedAtSim }),
      },
      complaint,
    );
    await ctx.audit({ outcome: check.verdict, refs: { chargeId: check.chargeId, evidenceId: recorded.evidenceId } });
    return ok({
      chargeCheckId: recorded.refId,
      evidenceId: recorded.evidenceId,
      verdict: check.verdict,
      charged: money(check.charged),
      expected: money(check.expectedAmount),
      chargedAtText: dayTimeText(check.chargedAtSim),
      feeCode: check.feeCode,
      clauseIds: [...check.clauseIds],
      reason: check.reason,
      reasonText: CHARGE_REASON_TEXT[check.reason],
      ...(check.reversal === undefined ? {} : { alreadyReversed: alreadyReversedView(check.reversal) }),
    });
  };

  const checkDuplicateDebit: ToolImplementation<ToolInput<Tools["check_duplicate_debit"]>> = async (ctx) => {
    const complaint = complaintOf(ctx);
    const loanId = ctx.input.loanId ?? complaint.subject?.loanId ?? (await onlyLoanOf(core, ctx));
    const check = await core().call("checkDuplicateDebit", coreContextOf(ctx), { params: { loanId }, body: ctx.input.instalment === undefined ? {} : { instalment: ctx.input.instalment } });
    if (check.customerId !== ctx.session.customerId) throw new ToolError("FORBIDDEN", "loanId is not a loan of this customer");
    const recorded = await recordEvidence(
      ctx,
      "DUPLICATE_CHECK",
      {
        loanId: check.loanId,
        verdict: check.verdict,
        ...(ctx.input.instalment === undefined ? {} : { instalment: ctx.input.instalment }),
        ...(check.duplicateDebitId === undefined ? {} : { duplicateDebitId: check.duplicateDebitId }),
        refundable: check.refundable,
        debits: check.debits.map((debit) => ({ debitId: debit.debitId, instalment: debit.instalment, amount: debit.amount, atSim: debit.atSim })),
      },
      complaint,
    );
    await ctx.audit({ outcome: check.verdict, refs: { loanId: check.loanId, evidenceId: recorded.evidenceId } });
    return ok({
      duplicateCheckId: recorded.refId,
      evidenceId: recorded.evidenceId,
      verdict: check.verdict,
      debits: check.debits.map((debit) => ({ debitId: debit.debitId, atText: dayTimeText(debit.atSim), amount: money(debit.amount), instalment: debit.instalment })),
      refundable: money(check.refundable),
    });
  };

  return { check_charge: checkCharge, check_duplicate_debit: checkDuplicateDebit } as const;
}
