// Each operation of the contract (`coreRoutes`, keyed by operationId) → its ledger function. The
// inputs arrive parsed with the route's own schemas (app.ts), so the types here are the contract's.
import type { coreRoutes } from "@reclamo/core-contract";
import type { z } from "zod";
import { getCustomer, getCustomerByPhone, getLiveRecipient } from "./ledger/accounts";
import { checkChallenge } from "./ledger/challenge";
import { requestClosure } from "./ledger/closure";
import type { LedgerContext } from "./ledger/context";
import { requestDataChange } from "./ledger/data-change";
import { checkDuplicateDebit, refundDuplicateDebit } from "./ledger/duplicates";
import { checkCharge } from "./ledger/fees";
import { setOutgoingFreeze } from "./ledger/freeze";
import { getDisbursement, getLoan, listInstalments } from "./ledger/loans";
import { listOperations } from "./ledger/operations";
import { recordWhatsAppOptOut } from "./ledger/opt-out";
import { applyPayment } from "./ledger/payments";
import { quoteEarlyPayoff } from "./ledger/payoff";
import { reverseCharge } from "./ledger/reversals";
import { creditTransferReversal } from "./ledger/transfer-credit";

type Routes = typeof coreRoutes;
type Operation = Exclude<keyof Routes, "getCoreHealth">;
type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface RouteInput<O extends Operation> {
  readonly params: z.infer<Routes[O]["params"]>;
  readonly query: Routes[O] extends { query: infer Q } ? Infer<Q> : undefined;
  readonly body: Routes[O] extends { body: infer B } ? Infer<B> : undefined;
}

type Handlers = { readonly [O in Operation]: (ctx: LedgerContext, input: RouteInput<O>) => Promise<z.infer<Routes[O]["ok"]>> };

export const CORE_HANDLERS: Handlers = {
  getCustomerByPhone: (ctx, { params }) => getCustomerByPhone(ctx, params.phoneHash),
  getCustomer: (ctx, { params }) => getCustomer(ctx, params.customerId),
  getLiveRecipient: (ctx, { params }) => getLiveRecipient(ctx, params.customerId),
  checkChallenge: (ctx, { params, body }) => checkChallenge(ctx, params.customerId, body),
  listOperations: (ctx, { params, query }) => listOperations(ctx, params.customerId, query),
  getLoan: (ctx, { params }) => getLoan(ctx, params.loanId),
  listInstalments: (ctx, { params }) => listInstalments(ctx, params.loanId),
  applyPayment: (ctx, { params, body }) => applyPayment(ctx, params.loanId, body),
  checkCharge: (ctx, { params }) => checkCharge(ctx, params.chargeId),
  reverseCharge: (ctx, { params, body }) => reverseCharge(ctx, params.chargeId, body),
  checkDuplicateDebit: (ctx, { params, body }) => checkDuplicateDebit(ctx, params.loanId, body.instalment),
  refundDuplicateDebit: (ctx, { body }) => refundDuplicateDebit(ctx, body),
  setOutgoingFreeze: (ctx, { params, body }) => setOutgoingFreeze(ctx, params.customerId, body),
  creditTransferReversal: (ctx, { params, body }) => creditTransferReversal(ctx, params.customerId, body),
  quoteEarlyPayoff: (ctx, { params, body }) => quoteEarlyPayoff(ctx, params.loanId, body),
  recordWhatsAppOptOut: (ctx, { params, body }) => recordWhatsAppOptOut(ctx, params.customerId, body),
  requestClosure: (ctx, { params, body }) => requestClosure(ctx, params.customerId, body),
  requestDataChange: (ctx, { params, body }) => requestDataChange(ctx, params.customerId, body),
  getDisbursement: (ctx, { params }) => getDisbursement(ctx, params.loanId),
};
