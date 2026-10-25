// The account reads of the `account` target (docs/tool-catalog.md): the customer's account, operations,
// loans, instalments and the early payoff quote, straight from the core. Every one needs the customer
// identified (`LAM-IDENTIFIED`, fences.ts) and every loan id of the input was already checked against
// the core by `LAM-SCOPE`; the customer is always the session's. Amounts and dates go out with their
// es-AR text (format.ts), every loan and instalment status with its neutral `statusText` of copy/ (what the
// customer reads; the raw status is for the code), and the core's free text (operation descriptions, loan labels, the block
// reason) is escaped by the wrapper as declared in schema.ts. A loan read and a payoff quote are also
// left as evidence on the complaint of the turn (evidence.ts).
import { ToolError, ok } from "@reclamo/shared";
import type { Customer, Instalment, Loan, Operation } from "@reclamo/core-contract";
import { ACCOUNT_BLOCK_CATEGORY_TEXT, INSTALMENT_STATUS_TEXT, LOAN_STATUS_TEXT } from "../../copy";
import type { ToolContext, ToolImplementation, ToolResponse } from "../common/context";
import type { ToolInput } from "../common/define";
import { type CorePort, coreContextOf } from "./core";
import { noteOnComplaint } from "./evidence";
import { dateText, dayText, dayTimeText, localDate, money, shiftDate } from "./format";
import type { ACCOUNT_TOOLS } from "./schema";

type Tools = typeof ACCOUNT_TOOLS;
type Impl<K extends keyof Tools> = ToolImplementation<ToolInput<Tools[K]>>;

/** Default window of `list_operations` (and of the worker's preload): the last 30 days of the world's clock. */
export const DEFAULT_OPERATIONS_DAYS = 30;
/** Widest window and most rows `list_operations` returns (docs/tool-catalog.md). */
export const MAX_OPERATIONS_DAYS = 90;
/** Default window of a `list_operations` of kind CHARGE: a disputed charge can be up to the widest window old. */
export const DEFAULT_CHARGES_DAYS = MAX_OPERATIONS_DAYS;
export const MAX_OPERATIONS_ROWS = 50;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The account summary the agent may read: never the phone, the document or the live number. */
export function accountView(customer: Customer) {
  const { account, wallet } = customer;
  return {
    account: {
      status: account.status,
      ...(account.blockCategory === undefined ? {} : { blockReason: { category: account.blockCategory, text: ACCOUNT_BLOCK_CATEGORY_TEXT[account.blockCategory] } }),
      emailMasked: customer.emailMasked,
    },
    wallet: { balance: money(wallet.balance), cvuMasked: wallet.cvuMasked, outgoingFrozen: wallet.outgoingFrozen },
    loans: customer.loans.map((loan) => ({ loanId: loan.loanId, label: loan.label, status: loan.status, statusText: LOAN_STATUS_TEXT[loan.status], outstanding: money(loan.outstanding) })),
  };
}

/** A charge the core already reversed names its credit note: it is not a charge to reverse again. */
function operationView(operation: Operation) {
  const { loanId, instalment, chargeId, transferId, creditNoteId } = operation.ref;
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    atText: dayTimeText(operation.atSim),
    amount: money(operation.amount),
    description: operation.description,
    status: operation.status,
    ...(operation.kind === "CHARGE" && creditNoteId !== undefined ? { alreadyReversed: true } : {}),
    ref: { ...(loanId === undefined ? {} : { loanId }), ...(instalment === undefined ? {} : { instalment }), ...(chargeId === undefined ? {} : { chargeId }), ...(transferId === undefined ? {} : { transferId }) },
  };
}

function loanView(loan: Loan) {
  return {
    loanId: loan.loanId,
    principal: money(loan.principal),
    instalmentsCount: loan.instalmentsCount,
    paidCount: loan.paidCount,
    status: loan.status,
    statusText: LOAN_STATUS_TEXT[loan.status],
    outstanding: money(loan.outstanding),
    ...(loan.cancelledAtSim === undefined ? {} : { cancelledAtText: dayText(loan.cancelledAtSim) }),
    ...(loan.nextDue === undefined ? {} : { nextDue: { number: loan.nextDue.number, dueText: dateText(loan.nextDue.dueDate), amount: money(loan.nextDue.amount) } }),
  };
}

function instalmentView(instalment: Instalment) {
  return {
    number: instalment.number,
    dueText: dateText(instalment.dueDate),
    amount: money(instalment.amount),
    outstanding: money(instalment.outstanding),
    status: instalment.status,
    statusText: INSTALMENT_STATUS_TEXT[instalment.status],
    payments: instalment.payments.map((payment) => ({
      paymentId: payment.paymentId,
      network: payment.network,
      operationCode: payment.operationCode,
      amount: money(payment.amount),
      appliedAtText: dayTimeText(payment.appliedAtSim),
    })),
  };
}

/** The operations window a call asks for, bounded by the world's today (`eventAtSim`). */
export function operationsWindow(
  ctx: Pick<ToolContext<unknown>, "session">,
  input: { readonly fromDate?: string | undefined; readonly toDate?: string | undefined; readonly kind?: string | undefined },
): { from: string; to: string } {
  const today = localDate(ctx.session.eventAtSim);
  const to = input.toDate !== undefined && input.toDate < today ? input.toDate : today;
  const from = input.fromDate ?? shiftDate(to, -(input.kind === "CHARGE" ? DEFAULT_CHARGES_DAYS : DEFAULT_OPERATIONS_DAYS));
  if (from > to) throw new ToolError("INVALID", "fromDate is after the last day with operations");
  if (daysBetween(from, to) > MAX_OPERATIONS_DAYS) throw new ToolError("INVALID", `at most ${MAX_OPERATIONS_DAYS} days per call`);
  return { from, to };
}

export function accountReads(core: CorePort) {
  const getAccount: Impl<"get_account"> = async (ctx): Promise<ToolResponse> => {
    const customer = await core().call("getCustomer", coreContextOf(ctx), { params: { customerId: ctx.session.customerId } });
    return ok(accountView(customer));
  };

  const listOperations: Impl<"list_operations"> = async (ctx) => {
    const { from, to } = operationsWindow(ctx, ctx.input);
    const list = await core().call("listOperations", coreContextOf(ctx), { params: { customerId: ctx.session.customerId }, query: { from, to, kind: ctx.input.kind ?? "ALL" } });
    const rows = list.operations.slice(0, MAX_OPERATIONS_ROWS);
    return ok({ fromText: dateText(from), toText: dateText(to), operations: rows.map(operationView), truncated: list.truncated || list.operations.length > rows.length });
  };

  const getLoan: Impl<"get_loan"> = async (ctx) => {
    const loan = await core().call("getLoan", coreContextOf(ctx), { params: { loanId: ctx.input.loanId } });
    if (loan.customerId !== ctx.session.customerId) throw new ToolError("FORBIDDEN", "loanId is not a loan of this customer");
    await noteOnComplaint(ctx, "LOAN_STATUS", {
      loanId: loan.loanId,
      status: loan.status,
      outstandingCents: loan.outstanding,
      paidCount: loan.paidCount,
      instalmentsCount: loan.instalmentsCount,
      ...(loan.cancelledAtSim === undefined ? {} : { cancelledAtSim: loan.cancelledAtSim }),
    }, loan.loanId);
    return ok({ loan: loanView(loan) });
  };

  const getInstalments: Impl<"get_instalments"> = async (ctx) => {
    const list = await core().call("listInstalments", coreContextOf(ctx), { params: { loanId: ctx.input.loanId } });
    if (list.customerId !== ctx.session.customerId) throw new ToolError("FORBIDDEN", "loanId is not a loan of this customer");
    return ok({ loanId: list.loanId, instalments: list.instalments.map(instalmentView) });
  };

  const quoteEarlyPayoff: Impl<"quote_early_payoff"> = async (ctx) => {
    const quote = await core().call("quoteEarlyPayoff", coreContextOf(ctx), { params: { loanId: ctx.input.loanId }, body: { customerId: ctx.session.customerId } });
    await ctx.audit({ outcome: "QUOTED", refs: { quoteId: quote.quoteId, loanId: quote.loanId } });
    await noteOnComplaint(ctx, "PAYOFF_QUOTE", {
      quoteId: quote.quoteId,
      loanId: quote.loanId,
      totalCents: quote.total,
      principalCents: quote.principal,
      accruedInterestCents: quote.accruedInterest,
      feeCents: quote.fee,
      ...(quote.feeClauseId === undefined ? {} : { feeClauseId: quote.feeClauseId }),
      validUntilSim: quote.validUntilSim,
    }, quote.loanId);
    return ok({
      quoteId: quote.quoteId,
      loanId: quote.loanId,
      total: money(quote.total),
      breakdown: { principal: money(quote.principal), accruedInterest: money(quote.accruedInterest), fee: money(quote.fee), ...(quote.feeClauseId === undefined ? {} : { feeClauseId: quote.feeClauseId }) },
      validUntilText: dayTimeText(quote.validUntilSim),
    });
  };

  return { get_account: getAccount, list_operations: listOperations, get_loan: getLoan, get_instalments: getInstalments, quote_early_payoff: quoteEarlyPayoff } as const;
}
