import { describe, expect, it } from "vitest";
import { allowedOutcomes, checkOutcome } from "./outcome";

const executed = (kind: "APPLY_PAYMENT" | "REFUND_DUPLICATE" | "ACCOUNT_CLOSURE") => ({ kind, status: "EXECUTED" as const });

describe("the outcome of an agent's resolution is the case file's [FL-022]", () => {
  it("an executed money action is IN_FAVOUR or PARTIALLY_IN_FAVOUR, whatever the type", () => {
    expect(allowedOutcomes("PAYMENT_NOT_REFLECTED", [executed("APPLY_PAYMENT")])).toEqual(["IN_FAVOUR", "PARTIALLY_IN_FAVOUR"]);
    expect(() => checkOutcome("DUPLICATE_DEBIT", [executed("REFUND_DUPLICATE")], "NOT_IN_FAVOUR")).toThrow(expect.objectContaining({ reason: "OUTCOME_MISMATCH" }));
  });

  it("a money complaint with no money moved is NOT_IN_FAVOUR or INFORMATIONAL; a referred or failed action moved nothing", () => {
    expect(allowedOutcomes("PAYMENT_NOT_REFLECTED", [])).toEqual(["NOT_IN_FAVOUR", "INFORMATIONAL"]);
    expect(allowedOutcomes("TRANSFER_NOT_CREDITED", [{ kind: "TRANSFER_REVERSAL", status: "FAILED" }])).toEqual(["NOT_IN_FAVOUR", "INFORMATIONAL"]);
    expect(() => checkOutcome("PAYMENT_NOT_REFLECTED", [], "IN_FAVOUR")).toThrow(expect.objectContaining({ code: "INVALID", reason: "OUTCOME_MISMATCH" }));
    expect(() => checkOutcome("DISBURSEMENT_NOT_RECEIVED", [], "INFORMATIONAL")).not.toThrow();
  });

  it("a type money does not decide (a certificate, a closure) takes any outcome but WITHDRAWN", () => {
    expect(() => checkOutcome("PAYOFF_CERTIFICATE", [], "IN_FAVOUR")).not.toThrow();
    expect(() => checkOutcome("CLOSURE_OR_EARLY_PAYOFF", [executed("ACCOUNT_CLOSURE")], "IN_FAVOUR")).not.toThrow();
    expect(() => checkOutcome("INFORMATION_REQUEST", [], "WITHDRAWN")).toThrow(expect.objectContaining({ reason: "OUTCOME_MISMATCH" }));
  });
});
