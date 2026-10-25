import { describe, expect, it } from "vitest";
import { ComplaintType } from "@reclamo/shared";
import { EvidenceKind } from "../domain/case-items";
import { foundsResolution } from "./foundation";

/** The allow-list of complaints/foundation.ts, written out: anything else founds nothing. */
const FOUNDED: Readonly<Record<ComplaintType, readonly EvidenceKind[]>> = {
  PAYMENT_NOT_REFLECTED: ["SETTLEMENT_MATCH"],
  UNRECOGNIZED_CHARGE: ["CHARGE_CHECK"],
  DUPLICATE_DEBIT: ["DUPLICATE_CHECK"],
  TRANSFER_NOT_CREDITED: ["TRANSFER_STATUS"],
  DISBURSEMENT_NOT_RECEIVED: ["DISBURSEMENT"],
  PAYOFF_CERTIFICATE: ["TERMS_CLAUSE", "LOAN_STATUS", "PAYOFF_QUOTE"],
  CLOSURE_OR_EARLY_PAYOFF: ["TERMS_CLAUSE", "LOAN_STATUS", "PAYOFF_QUOTE"],
  INFORMATION_REQUEST: ["TERMS_CLAUSE", "LOAN_STATUS", "PAYOFF_QUOTE"],
  UNKNOWN_OPERATION: [],
  ACCOUNT_BLOCKED: [],
  DATA_CHANGE: [],
};

describe("Which evidence founds RESOLVED, per complaint type", () => {
  for (const type of ComplaintType.options) {
    it(`${type}: only ${FOUNDED[type].join(", ") || "an action or an operator"}`, () => {
      const founding = EvidenceKind.options.filter((kind) => foundsResolution(type, kind));
      expect(founding).toEqual(FOUNDED[type]);
    });
  }

  it("evidence of another type's investigation never founds a complaint nobody investigated", () => {
    for (const kind of ["SETTLEMENT_MATCH", "CHARGE_CHECK", "DUPLICATE_CHECK", "TRANSFER_STATUS", "DISBURSEMENT", "RECEIPT_READING"] as const) {
      for (const type of ["UNKNOWN_OPERATION", "ACCOUNT_BLOCKED", "DATA_CHANGE"] as const) expect(foundsResolution(type, kind)).toBe(false);
    }
    expect(foundsResolution("PAYMENT_NOT_REFLECTED", "CHARGE_CHECK")).toBe(false);
    expect(foundsResolution("PAYMENT_NOT_REFLECTED", "RECEIPT_READING")).toBe(false);
  });
});
