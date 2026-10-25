// Contracts of the simulated lender core (core.openapi.yaml) and networks (networks.openapi.yaml):
// the zod schemas the client and the mocks share. Explicit re-exports only (no automatic barrel).

export {
  CONTRACT_VERSION,
  CORRELATION_HEADER,
  CalendarDate,
  Cents,
  ContractErrorCode,
  CorrelationId,
  CustomerId,
  ERROR_STATUS,
  ERROR_STATUSES,
  ErrorBody,
  Health,
  HealthService,
  IdempotencyKey,
  InstalmentNumber,
  LoanId,
  NoParams,
  OperationCode,
  PositiveCents,
  ResourceId,
  SIM_NOW_HEADER,
  SimInstant,
  WorldHeaders,
  WorldId,
  WorldParams,
  errorResponse,
} from "./common";
export type { ErrorStatus } from "./common";

export {
  Account,
  AccountStatus,
  BlockCategory,
  ChallengeCheckRequest,
  ChallengeCheckResult,
  ChallengeKind,
  ClosureCondition,
  ClosureRequest,
  ClosureResult,
  Customer,
  CustomerRef,
  DataChangeField,
  DataChangeRequest,
  DataChangeResult,
  FreezeRequest,
  FreezeResult,
  LiveRecipient,
  LoanStatus,
  LoanSummary,
  Operation,
  OperationKind,
  OperationKindFilter,
  OperationList,
  OperationRef,
  OperationStatus,
  OperationsQuery,
  PhoneHash,
  PresenterDocument,
  TransferReversalCreditRequest,
  TransferReversalCreditResult,
  Wallet,
  WhatsAppConsent,
  WhatsAppOptOutRequest,
  WhatsAppOptOutResult,
} from "./core-accounts";

export {
  Allocation,
  AppliedChargeReversal,
  AppliedPayment,
  ChargeCheck,
  ChargeCheckReason,
  ChargeReversalRequest,
  ChargeReversalResult,
  ChargeVerdict,
  ClauseId,
  Debit,
  Disbursement,
  DisbursementStatus,
  DuplicateCheck,
  DuplicateCheckRequest,
  FeeCode,
  Instalment,
  InstalmentList,
  InstalmentStatus,
  Loan,
  NextDue,
  PaymentNetwork,
  PaymentRequest,
  PaymentResult,
  PaymentSource,
  PayoffQuote,
  PayoffQuoteRequest,
  RefundRequest,
  RefundResult,
} from "./core-loans";

export {
  BatchStatus,
  CollectionNetwork,
  CollectionRequest,
  CollectionResult,
  PublishResult,
  SettlementBatch,
  SettlementBatchList,
  SettlementKey,
  SettlementLine,
  SettlementsQuery,
  Sha256Hex,
  Terminal,
  TransferReversalRequest,
  TransferReversalResult,
  TransferState,
  TransferStatus,
  TransitionRequest,
} from "./networks";

export {
  SETTLEMENT_CSV_HEADER,
  SETTLEMENT_CSV_MAX_BYTES,
  SETTLEMENT_CSV_MAX_LINES,
  SettlementCsvError,
  centsToDecimal,
  decimalToCents,
  formatSettlementCsv,
  parseSettlementCsv,
} from "./settlement-csv";
export type { ExpectedBatch } from "./settlement-csv";

export { coreRoutes } from "./core-routes";
export { networksRoutes } from "./networks-routes";
export { defineRoute, fillPath, findRoute, matchPath, pathParamNames } from "./routes";
export type { HttpMethod, RouteMatch, RouteSpec, RouteTable } from "./routes";

export { componentId, coreRegistry, networksRegistry } from "./registry";
export type { ComponentMeta, ComponentRegistry } from "./registry";

export { CONTRACT_DOCUMENTS, coreContract, networksContract } from "./documents";
export type { ContractDocument } from "./documents";
