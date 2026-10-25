// Wire primitives shared by the lender core and the simulated networks
// (docs/architecture-integrations.md §5-§6). Amounts travel as integer centavos, instants as ISO
// 8601 with offset in the world's simulated time, and every object is strict: a field the contract
// does not name (a live phone number, an expected challenge answer) never crosses the wire.
//
// The package is self-contained on purpose (only zod): it is the published contract of two
// external systems. The one enum it mirrors from @reclamo/shared (`PaymentNetwork` = `Network`) is
// kept equal by `npm run core:contract`.
import { z } from "zod";
import { shared } from "./registry";

/** Version of both documents (`info.version` in the YAML, `contractVersion` of `/v1/health`). */
export const CONTRACT_VERSION = "1.0.0";

/** Header with the world's simulated instant: the mocks never read a clock (ADR-0011). */
export const SIM_NOW_HEADER = "x-sim-now";
/** Optional header that the mocks copy into their JSON logs. */
export const CORRELATION_HEADER = "x-correlation-id";

// docs/architecture.md §5: `worldId` fits schedule names, so the wire accepts only this shape.
export const WorldId = shared("WorldId", z.string().regex(/^[a-z0-9-]{1,24}$/));
export type WorldId = z.infer<typeof WorldId>;

export const CustomerId = shared("CustomerId", z.string().max(64).regex(/^cus-[a-z0-9]+(?:-[a-z0-9]+)*$/));
export type CustomerId = z.infer<typeof CustomerId>;

export const LoanId = shared("LoanId", z.string().max(64).regex(/^L-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/));
export type LoanId = z.infer<typeof LoanId>;

/** Ids the core and the networks mint or receive (charges, debits, transfers, actions, complaints). */
export const ResourceId = shared("ResourceId", z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/));
export type ResourceId = z.infer<typeof ResourceId>;

export const IdempotencyKey = shared("IdempotencyKey", z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:#/._-]{0,127}$/));
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/** Payment identifier, unique per network (`NTE-20261006-004817-7`); its check digit is validated by the reader. */
export const OperationCode = shared("OperationCode", z.string().max(64).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/));
export type OperationCode = z.infer<typeof OperationCode>;

/** Integer centavos of Argentine pesos. */
export const Cents = shared("Cents", z.number().int().min(0).max(10_000_000_000));
export type Cents = z.infer<typeof Cents>;

export const PositiveCents = shared("PositiveCents", z.number().int().min(1).max(10_000_000_000));
export type PositiveCents = z.infer<typeof PositiveCents>;

export const SimInstant = shared(
  "SimInstant",
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/)
    .meta({ format: "date-time" }),
);
export type SimInstant = z.infer<typeof SimInstant>;

export const CalendarDate = shared(
  "CalendarDate",
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
    .meta({ format: "date" }),
);
export type CalendarDate = z.infer<typeof CalendarDate>;

export const CorrelationId = shared("CorrelationId", z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/));
export type CorrelationId = z.infer<typeof CorrelationId>;

export const InstalmentNumber = shared("InstalmentNumber", z.number().int().min(1).max(18));
export type InstalmentNumber = z.infer<typeof InstalmentNumber>;

export const ContractErrorCode = shared(
  "ContractErrorCode",
  z.enum([
    "INVALID",
    "WORLD_NOT_FOUND",
    "NOT_FOUND",
    "FORBIDDEN",
    "CALLER_NOT_ALLOWED",
    "CALLER_WORLD_DENIED",
    "CONFLICT",
    "ABOVE_CAP",
    "EXCEEDS_OUTSTANDING",
    "NOT_ELIGIBLE",
    "UNAVAILABLE",
  ]),
);
export type ContractErrorCode = z.infer<typeof ContractErrorCode>;

/** Body of every error response; `actionId` only with `CONFLICT` on a money route (the existing action). */
export const ErrorBody = shared(
  "ErrorBody",
  z.object({ code: ContractErrorCode, message: z.string().min(1).max(300), actionId: ResourceId.optional() }).strict(),
);
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ERROR_STATUSES = [400, 403, 404, 409, 422, 503] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

export const ERROR_STATUS: Readonly<Record<ContractErrorCode, ErrorStatus>> = {
  INVALID: 400,
  WORLD_NOT_FOUND: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CALLER_NOT_ALLOWED: 403,
  CALLER_WORLD_DENIED: 403,
  CONFLICT: 409,
  ABOVE_CAP: 422,
  EXCEEDS_OUTSTANDING: 422,
  NOT_ELIGIBLE: 422,
  UNAVAILABLE: 503,
};

/** The HTTP status and body a mock answers for a contract error. */
export function errorResponse(code: ContractErrorCode, message: string, actionId?: ResourceId): { statusCode: ErrorStatus; body: ErrorBody } {
  const body = ErrorBody.parse(actionId === undefined ? { code, message } : { code, message, actionId });
  return { statusCode: ERROR_STATUS[code], body };
}

export const HealthService = shared("HealthService", z.enum(["core", "networks"]));
export type HealthService = z.infer<typeof HealthService>;

export const Health = shared(
  "Health",
  z.object({ status: z.literal("ok"), service: HealthService, contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
);
export type Health = z.infer<typeof Health>;

/** Path parameters of `/v1/health`, and the base of every world route. */
export const NoParams = z.object({}).strict();
export const WorldParams = z.object({ worldId: WorldId }).strict();

/** Headers of every world route; loose, because the Function URL adds its own. */
export const WorldHeaders = z.object({ [SIM_NOW_HEADER]: SimInstant, [CORRELATION_HEADER]: CorrelationId.optional() });
export type WorldHeaders = z.infer<typeof WorldHeaders>;
