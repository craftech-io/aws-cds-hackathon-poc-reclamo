import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONTRACT_VERSION, CalendarDate, ERROR_STATUS, ErrorBody, Health, OperationCode, SimInstant, WorldId, errorResponse } from "./common";
import { ChallengeCheckResult, Customer, OperationList } from "./core-accounts";
import { PaymentRequest, PaymentResult } from "./core-loans";
import { CollectionResult, SettlementBatch, TransferStatus } from "./networks";
import { core } from "./registry";

const NOW = "2026-10-07T10:10:00-03:00";

const customer = {
  customerId: "cus-0001",
  firstName: "Valeria",
  lastName: "Quiroga",
  document: { type: "DNI", numberMasked: "••••0001" },
  phoneMasked: "+54 9 11 •••• 1001",
  emailMasked: "s•••@simulator.amazonses.com",
  whatsapp: { optedIn: true, optedInAtSim: "2025-03-01T10:00:00-03:00", optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: false },
  account: { status: "ACTIVE" },
  wallet: { balance: 1250000, cvuMasked: "•••• 4821", outgoingFrozen: false },
  loans: [{ loanId: "L-0001", label: "Préstamo personal 12 cuotas", status: "IN_ARREARS", outstanding: 94912000 }],
};

describe("wire primitives", () => {
  it("accept the documented shapes", () => {
    for (const world of ["demo", "g01", "gprobe", "qamin", "qa-r20261001a-sc21", "sim-b1"]) expect(WorldId.safeParse(world).success, world).toBe(true);
    expect(OperationCode.safeParse("NTE-20261006-004817-7").success).toBe(true);
    expect(SimInstant.safeParse("2026-10-06T18:40:00-03:00").success).toBe(true);
    expect(SimInstant.safeParse("2026-10-06T21:40:00.123Z").success).toBe(true);
    expect(CalendarDate.safeParse("2026-10-07").success).toBe(true);
  });

  it("refuse what the contract does not allow", () => {
    expect(WorldId.safeParse("a".repeat(25)).success).toBe(false);
    expect(WorldId.safeParse("Demo").success).toBe(false);
    expect(SimInstant.safeParse("2026-10-06T18:40:00").success).toBe(false);
    expect(SimInstant.safeParse("2026-13-06T18:40:00Z").success).toBe(false);
    expect(CalendarDate.safeParse("07/10/2026").success).toBe(false);
    expect(OperationCode.safeParse("NTE 2026").success).toBe(false);
  });
});

describe("closed objects", () => {
  it("parse a customer and refuse one carrying a field the contract does not name", () => {
    expect(Customer.parse(customer)).toEqual(customer);
    expect(Customer.safeParse({ ...customer, liveE164: "5491100001001" }).success).toBe(false);
    expect(Customer.safeParse({ ...customer, wallet: { ...customer.wallet, cvu: "9990000000000000004821" } }).success).toBe(false);
  });

  it("never lets a challenge check carry the expected value", () => {
    expect(ChallengeCheckResult.parse({ ok: false })).toEqual({ ok: false });
    expect(ChallengeCheckResult.safeParse({ ok: false, expected: "2026-10-05" }).success).toBe(false);
  });

  it("take amounts as integer centavos", () => {
    const request = {
      customerId: "cus-0001",
      complaintId: "cmp-01",
      reconciliationId: "rec-01",
      network: "NORTE",
      operationCode: "NTE-20261006-004817-7",
      amount: 11864000,
      paidAtSim: "2026-10-06T18:40:00-03:00",
      source: "SETTLEMENT",
      idempotencyKey: "cmp-01#apply#rec-01",
      cap: 20000000,
    };
    expect(PaymentRequest.safeParse(request).success).toBe(true);
    expect(PaymentRequest.safeParse({ ...request, amount: 118640.0 + 0.5 }).success).toBe(false);
    expect(PaymentRequest.safeParse({ ...request, amount: 0 }).success).toBe(false);
    expect(PaymentRequest.safeParse({ ...request, decision: "APPROVED" }).success).toBe(false);
    expect(
      PaymentResult.safeParse({
        actionId: "act-01",
        paymentId: "pay-01",
        applied: 11864000,
        lateInterest: 0,
        allocations: [{ instalment: 4, amount: 11864000, statusAfter: "PAID" }],
        loanStatusAfter: "ACTIVE",
        outstandingAfter: 83048000,
      }).success,
    ).toBe(true);
  });

  it("parse the networks' answers", () => {
    const pending = { network: "NORTE", businessDate: "2026-10-07", status: "PENDING", publishAtSim: "2026-10-08T08:30:00-03:00" };
    expect(SettlementBatch.safeParse(pending).success).toBe(true);
    const published = { ...pending, status: "PUBLISHED", publishedAtSim: "2026-10-08T08:30:00-03:00", lineCount: 31, sha256: "0".repeat(64) };
    for (const s3Key of ["W/demo/NORTE/2026-10-07/batch-1.csv", "qa/r1/qa-r1-sc02/NORTE/2026-10-07/batch-2.csv"]) {
      expect(SettlementBatch.safeParse({ ...published, s3Key }).success, s3Key).toBe(true);
    }
    for (const s3Key of ["../NORTE/2026-10-07/batch-1.csv", "W/demo/OESTE/2026-10-07/batch-1.csv", "W/demo/NORTE/2026-10-07/batch-1.txt"]) {
      expect(SettlementBatch.safeParse({ ...published, s3Key }).success, s3Key).toBe(false);
    }
    expect(
      CollectionResult.safeParse({ network: "NORTE", operationCode: "NTE-20261006-004817-7", businessDate: "2026-10-07", batch: pending, batchCreated: false }).success,
    ).toBe(true);
    expect(TransferStatus.safeParse({ transferId: "TRF-27", status: "COMPLETED", traceId: "TRZ-7F3K9Q", completedAtSim: NOW }).success).toBe(true);
    expect(TransferStatus.safeParse({ transferId: "TRF-31", status: "UNKNOWN" }).success).toBe(true);
    expect(OperationList.safeParse({ customerId: "cus-0001", from: "2026-07-09", to: "2026-10-07", operations: [], truncated: false }).success).toBe(true);
  });
});

describe("errors and health", () => {
  it("map every error code to its status", () => {
    expect(errorResponse("CONFLICT", "claim exists", "act-01")).toEqual({ statusCode: 409, body: { code: "CONFLICT", message: "claim exists", actionId: "act-01" } });
    expect(errorResponse("CALLER_WORLD_DENIED", "world not allowed for this caller")).toEqual({
      statusCode: 403,
      body: { code: "CALLER_WORLD_DENIED", message: "world not allowed for this caller" },
    });
    expect(Object.values(ERROR_STATUS).every((status) => [400, 403, 404, 409, 422, 503].includes(status))).toBe(true);
    expect(ErrorBody.safeParse({ code: "TEAPOT", message: "x" }).success).toBe(false);
  });

  it("report the contract version", () => {
    expect(Health.parse({ status: "ok", service: "core", contractVersion: CONTRACT_VERSION }).contractVersion).toBe("1.0.0");
  });
});

describe("registry", () => {
  it("refuses two components with one name", () => {
    expect(() => core("Loan", z.string())).toThrow('contract component "Loan" registered twice');
  });
});
