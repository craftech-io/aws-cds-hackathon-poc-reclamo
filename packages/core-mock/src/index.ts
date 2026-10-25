// Package entry of the simulated lender core: the app (request → response), its stores, the item
// schemas and keys the seed writes, and the pure rules other packages reuse (the seed's invariants
// run the real ledger). Explicit re-exports only (no automatic barrel).

export { CORE_MOCK_ROUTES, createCoreApp } from "./app";
export type { CoreAppDeps, CoreEvent, CoreOperation } from "./app";

export { CALLER_WORLDS, CoreCaller, MockCallersLink, authorizeWorld, callerDirectory, roleIdentity, sessionIdentity } from "./http/caller";
export type { CallerDirectory, WorldDecision } from "./http/caller";
export { MAX_BODY_BYTES, toCoreRequest } from "./http/event";
export type { CoreHttpRequest, CoreHttpResponse } from "./http/event";

export { LedgerError, localDate } from "./ledger/context";
export type { LedgerContext } from "./ledger/context";
export { amountMatches, dateMatches, parseAmountAnswer, parseDateAnswer } from "./ledger/challenge";
export { closureConditions } from "./ledger/closure";
export { DUPLICATE_WINDOW_MS, findDuplicates } from "./ledger/duplicates";
export { AMOUNT_TOLERANCE, CARD_REPLACEMENT_FEE, FEE_CLAUSES, FEE_SCHEDULE_VERSION, evaluateCharge, originationFee } from "./ledger/fees";
export type { ChargeFacts, ChargeVerdictDetail } from "./ledger/fees";
export { instalmentOutstanding, instalmentStatus, loanOutstanding, loanStatus } from "./ledger/loans";
export { LATE_TOLERANCE_DAYS, lateInterestFor, planAllocation } from "./ledger/payments";
export { CORE_HOLIDAYS, endOfBusinessDay, payoffFigures } from "./ledger/payoff";
export { COMPENSATORY_FACTOR, compensatoryInterest } from "./ledger/reversals";

export {
  AccountItem,
  ActionClaimItem,
  ChargeItem,
  CreditNoteItem,
  CustomerItem,
  InstalmentItem,
  LoanItem,
  MovementItem,
  OwnerItem,
  PaymentItem,
  PayoffQuoteItem,
  PhoneClaimItem,
  TransferItem,
  WalletItem,
} from "./store/items";
export { MOVEMENT_PREFIX, SK, coreKeys, utcSortKey } from "./store/keys";
export type { ClaimKind } from "./store/keys";
export { createMemoryCoreStore } from "./store/memory";
export type { MemoryCoreStore } from "./store/memory";
export { StoreConflictError, StoreUnavailableError } from "./store/port";
export type { CoreStore, PutWrite, StoredItem } from "./store/port";
