// What a money action moves and how it is executed (`LAM-CAP`, `LAM-EVIDENCE`, docs/architecture.md §8.5).
// The amount never comes from the model: it comes from the evidence of the complaint and, where the
// core can recompute it, from the core itself at the moment of acting (a charge checked again, a
// duplicate checked again, a transfer's state read again). The same plan serves the agent's tool, the
// approval request (which fixes the action and the amount by code) and the worker that executes an
// approved action after re-reading it.
//
// Every core call carries the session's customer, the complaint, an idempotency key and the caller's
// cap; the core (or the transfer network) takes the natural-key claim (`OPC#`, `REV#`, `RFD#`, `TRV#`)
// in the transaction that moves the money, so a second attempt answers `CONFLICT` with the existing
// action and moves nothing.
import type { ChargeCheck } from "@reclamo/core-contract";
import { type CapAction, ToolError, pesosFromCents } from "@reclamo/shared";
import type { CoreClient } from "../../core/client";
import { CoreError } from "../../core/errors";
import type { NetworkClient } from "../../networks/client";
import { NetworkClientError } from "../../networks/errors";
import { deadlineText } from "../../complaints/sla";
import { alreadyReversedView } from "../account/format";
import type { Evidence } from "../../domain/case-items";
import { type MoneyDetails, matchedPaymentOf, moneyDetails } from "./evidence";

/** Who acts and when: the session's world and customer, the complaint, the world's simulated now. */
export interface MoneyEnv {
  readonly core: CoreClient;
  readonly networks: NetworkClient;
  readonly worldId: string;
  readonly customerId: string;
  readonly complaintId: string;
  readonly simNow: string;
  readonly correlationId: string;
  /** The world's synthetic reference rate (compensatory interest of a charge reversal). */
  readonly referenceRate: { readonly annualRate: number; readonly label: string };
}

export interface MoneyPlan {
  readonly action: CapAction;
  readonly evidence: Evidence;
  /** Centavos the action moves (the interest of a reversal is on top, decided by the core). */
  readonly amountCents: number;
  /** The natural-key claim the core takes (`OPC#<network>#<code>`, `REV#<charge>`, `RFD#<debit>`, `TRV#<transfer>`). */
  readonly claimKey: string;
  /** What the refund register calls the product (a fee code, a loan, a transfer). */
  readonly product: string;
  readonly execute: (request: { readonly cap: number; readonly idempotencyKey: string }) => Promise<MoneyExecution>;
  /**
   * The core already moved this money under another complaint (a charge reversed earlier): the tool
   * answers it before the cap, so nobody asks for a second approval. The worker still executes and gets
   * the core's `CONFLICT`.
   */
  readonly alreadyDone?: AlreadyDone;
}

export interface AlreadyDone {
  readonly reason: "ALREADY_REVERSED";
  readonly coreActionId: string;
  /** The tool's answer fields: what went back to the customer and when. */
  readonly output: Readonly<Record<string, unknown>>;
}

export interface MoneyExecution {
  /** The action the core recorded (it holds the claim). */
  readonly coreActionId: string;
  readonly amountCents: number;
  readonly interestCents: number;
  readonly creditNoteId?: string;
  /** Simulated instant the money moved. */
  readonly atSim: string;
  /** The tool's answer fields (docs/tool-catalog.md, target `actions`). */
  readonly output: Readonly<Record<string, unknown>>;
}

/** A refusal of the core or the network as the tool answers it: `CONFLICT` keeps the existing action. */
export class MoneyRefusal extends ToolError {
  constructor(
    code: ToolError["code"],
    message: string,
    readonly existingActionId?: string,
  ) {
    super(code, message, code === "CONFLICT" ? "ALREADY_EXECUTED" : undefined);
  }
}

const NETWORK_CODE: Readonly<Record<string, ToolError["code"]>> = {
  CONFLICT: "CONFLICT",
  ABOVE_CAP: "ABOVE_CAP",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  EXCEEDS_OUTSTANDING: "NOT_ELIGIBLE",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  WORLD_NOT_FOUND: "NOT_FOUND",
  INVALID: "INVALID",
};

/** Normalizes what the core or the network refused; anything else is rethrown as it was. */
export function asMoneyRefusal(error: unknown): unknown {
  if (error instanceof CoreError) return new MoneyRefusal(error.code, error.message, error.actionId);
  if (error instanceof NetworkClientError) return new MoneyRefusal(NETWORK_CODE[error.code] ?? "UNAVAILABLE", error.message, error.details.actionId);
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asMoneyRefusal(error);
  }
}

function coreCtx(env: MoneyEnv) {
  return { worldId: env.worldId, simNow: env.simNow, correlationId: env.correlationId };
}

function evidenceRef(evidence: Evidence): string {
  return evidence.refId ?? evidence.evidenceId;
}

function planPayment(env: MoneyEnv, evidence: Evidence, details: MoneyDetails<"APPLY_PAYMENT">): MoneyPlan {
  const payment = matchedPaymentOf(details);
  if (payment.customerRef !== undefined && payment.customerRef !== env.customerId) throw new ToolError("EVIDENCE_REQUIRED", "the matched line is not of this customer", "PAYER_MISMATCH");
  return {
    action: "APPLY_PAYMENT",
    evidence,
    amountCents: payment.amount,
    claimKey: `OPC#${payment.network}#${payment.operationCode}`,
    product: payment.loanId,
    execute: ({ cap, idempotencyKey }) =>
      guarded(async () => {
        const result = await env.core.call("applyPayment", coreCtx(env), {
          params: { loanId: payment.loanId },
          body: {
            customerId: env.customerId,
            complaintId: env.complaintId,
            reconciliationId: evidenceRef(evidence),
            network: payment.network,
            operationCode: payment.operationCode,
            amount: payment.amount,
            paidAtSim: payment.paidAt,
            source: payment.source,
            idempotencyKey,
            cap,
          },
        });
        return {
          coreActionId: result.actionId,
          amountCents: result.applied,
          interestCents: 0,
          atSim: env.simNow,
          output: {
            actionId: result.actionId,
            applied: pesosFromCents(result.applied),
            allocations: result.allocations.map((allocation) => ({ instalment: allocation.instalment, amount: pesosFromCents(allocation.amount), statusAfter: allocation.statusAfter })),
            loanStatusAfter: result.loanStatusAfter,
          },
        };
      }),
  };
}

async function planChargeReversal(env: MoneyEnv, evidence: Evidence, details: MoneyDetails<"REVERSE_CHARGE">): Promise<MoneyPlan> {
  const check: ChargeCheck = await guarded(() => env.core.call("checkCharge", coreCtx(env), { params: { chargeId: details.chargeId } }));
  if (check.customerId !== env.customerId) throw new ToolError("FORBIDDEN", "the charge is not of this customer", "NOT_IN_SESSION");
  if (check.verdict !== "WRONG") throw new ToolError("EVIDENCE_REQUIRED", "the core no longer finds the charge wrong", "EVIDENCE_RESULT");
  const amountCents = check.charged - check.expectedAmount;
  if (amountCents <= 0) throw new ToolError("NOT_ELIGIBLE", "nothing was charged above the schedule");
  // Reversed under another complaint: answered before the cap. Under this one, the core replays its answer.
  const reversal = check.reversal?.complaintId === env.complaintId ? undefined : check.reversal;
  return {
    action: "REVERSE_CHARGE",
    evidence,
    amountCents,
    claimKey: `REV#${details.chargeId}`,
    product: check.feeCode,
    ...(reversal === undefined
      ? {}
      : {
          alreadyDone: {
            reason: "ALREADY_REVERSED",
            coreActionId: reversal.actionId,
            output: alreadyReversedView(reversal),
          },
        }),
    execute: ({ cap, idempotencyKey }) =>
      guarded(async () => {
        const result = await env.core.call("reverseCharge", coreCtx(env), {
          params: { chargeId: details.chargeId },
          body: { customerId: env.customerId, complaintId: env.complaintId, idempotencyKey, cap, referenceRate: env.referenceRate.annualRate },
        });
        return {
          coreActionId: result.actionId,
          amountCents: result.amount,
          interestCents: result.compensatoryInterest,
          creditNoteId: result.creditNoteId,
          atSim: result.creditedAtSim,
          output: {
            actionId: result.actionId,
            reversed: pesosFromCents(result.amount),
            compensatoryInterest: pesosFromCents(result.compensatoryInterest),
            creditNoteId: result.creditNoteId,
            rateLabel: env.referenceRate.label,
          },
        };
      }),
  };
}

async function planDuplicateRefund(env: MoneyEnv, evidence: Evidence, details: MoneyDetails<"REFUND_DUPLICATE">): Promise<MoneyPlan> {
  const check = await guarded(() =>
    env.core.call("checkDuplicateDebit", coreCtx(env), { params: { loanId: details.loanId }, body: details.instalment === undefined ? {} : { instalment: details.instalment } }),
  );
  if (check.customerId !== env.customerId) throw new ToolError("FORBIDDEN", "the loan is not of this customer", "NOT_IN_SESSION");
  const debitId = check.duplicateDebitId;
  // Already refunded, the check still names the duplicate (refundable 0): the core answers CONFLICT with the refund.
  const amountCents = check.debits.find((debit) => debit.debitId === debitId)?.amount ?? check.refundable;
  if (check.verdict !== "DUPLICATE" || debitId === undefined || amountCents <= 0) throw new ToolError("EVIDENCE_REQUIRED", "the core no longer finds a duplicate debit to refund", "EVIDENCE_RESULT");
  return {
    action: "REFUND_DUPLICATE",
    evidence,
    amountCents,
    claimKey: `RFD#${debitId}`,
    product: details.loanId,
    execute: ({ cap, idempotencyKey }) =>
      guarded(async () => {
        const result = await env.core.call("refundDuplicateDebit", coreCtx(env), {
          params: {},
          body: { customerId: env.customerId, complaintId: env.complaintId, debitId, idempotencyKey, cap },
        });
        return {
          coreActionId: result.actionId,
          amountCents: result.amount,
          interestCents: 0,
          creditNoteId: result.creditNoteId,
          atSim: result.creditedAtSim,
          output: { actionId: result.actionId, refunded: pesosFromCents(result.amount), creditNoteId: result.creditNoteId },
        };
      }),
  };
}

async function planTransferReversal(env: MoneyEnv, evidence: Evidence, details: MoneyDetails<"TRANSFER_REVERSAL">): Promise<MoneyPlan> {
  const call = coreCtx(env);
  const status = await guarded(() => env.networks.getTransfer(call, details.transferId));
  // Already reversed, the network answers CONFLICT with the reversal (or replays it to the same key).
  if (status.status !== "REJECTED_NOT_REVERSED" && status.status !== "REJECTED_REVERSED") throw new ToolError("EVIDENCE_REQUIRED", `the transfer is ${status.status} now`, "EVIDENCE_RESULT");
  return {
    action: "TRANSFER_REVERSAL",
    evidence,
    amountCents: details.amount,
    claimKey: `TRV#${details.transferId}`,
    product: details.transferId,
    execute: ({ cap, idempotencyKey }) =>
      guarded(async () => {
        // The network confirms the reversal, then the core credits the wallet (claim TRV# on both sides).
        const reversal = await env.networks.requestTransferReversal(call, details.transferId, { customerId: env.customerId, complaintId: env.complaintId, idempotencyKey, cap });
        const credit = await env.core.call("creditTransferReversal", call, { params: { customerId: env.customerId }, body: { complaintId: env.complaintId, transferId: details.transferId, idempotencyKey } });
        return {
          coreActionId: reversal.actionId,
          amountCents: credit.amount,
          interestCents: 0,
          atSim: credit.creditedAtSim,
          output: { actionId: reversal.actionId, reversed: pesosFromCents(credit.amount), creditedAtText: deadlineText(credit.creditedAtSim) },
        };
      }),
  };
}

/** The plan of `action` founded on `evidence`; `EVIDENCE_REQUIRED` when the evidence does not found it. */
export async function planMoneyAction(action: CapAction, evidence: Evidence, env: MoneyEnv): Promise<MoneyPlan> {
  switch (action) {
    case "APPLY_PAYMENT":
      return planPayment(env, evidence, moneyDetails("APPLY_PAYMENT", evidence));
    case "REVERSE_CHARGE":
      return planChargeReversal(env, evidence, moneyDetails("REVERSE_CHARGE", evidence));
    case "REFUND_DUPLICATE":
      return planDuplicateRefund(env, evidence, moneyDetails("REFUND_DUPLICATE", evidence));
    case "TRANSFER_REVERSAL":
      return planTransferReversal(env, evidence, moneyDetails("TRANSFER_REVERSAL", evidence));
  }
}
