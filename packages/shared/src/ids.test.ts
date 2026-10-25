import { describe, expect, it } from "vitest";
import { ComplaintNumber, CustomerId, Id, LoanId, StaffId, complaintNumber, parseComplaintNumber } from "./ids";

describe("ids", () => {
  it("accepts the documented forms and rejects look-alikes", () => {
    expect(CustomerId.safeParse("cus-0001").success).toBe(true);
    expect(CustomerId.safeParse("cus-qa-r1-sc01-c01").success).toBe(true);
    expect(CustomerId.safeParse("CUS-0001").success).toBe(false);
    expect(StaffId.safeParse("stf-guest-03").success).toBe(true);
    expect(StaffId.safeParse("stf-").success).toBe(false);
    expect(LoanId.safeParse("L-0001").success).toBe(true);
    expect(LoanId.safeParse("L-").success).toBe(false);
    expect(Id.safeParse("W#demo").success).toBe(false);
    expect(Id.safeParse("a/b").success).toBe(false);
  });

  it("builds and parses complaint numbers, correlative per year", () => {
    expect(complaintNumber(2026, 1)).toBe("R-2026-000001");
    expect(complaintNumber(2026, 999_999)).toBe("R-2026-999999");
    expect(ComplaintNumber.safeParse(complaintNumber(2026, 42)).success).toBe(true);
    expect(parseComplaintNumber("R-2026-000123")).toEqual({ year: 2026, sequence: 123 });
    expect(parseComplaintNumber("R-2026-000000")).toBeUndefined();
    expect(parseComplaintNumber("R-26-000001")).toBeUndefined();
  });

  it("refuses a sequence or a year out of range", () => {
    expect(() => complaintNumber(2026, 0)).toThrow(RangeError);
    expect(() => complaintNumber(2026, 1_000_000)).toThrow(RangeError);
    expect(() => complaintNumber(2026, 1.5)).toThrow(RangeError);
    expect(() => complaintNumber(99, 1)).toThrow(RangeError);
  });
});
