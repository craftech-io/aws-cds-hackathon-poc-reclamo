import { describe, expect, it } from "vitest";
import { deadline, localDateAr, milestones, nthBusinessDay } from "./business-days";

// Synthetic holiday table for the tests (the real one lives in Reference, docs/seed-spec.md).
const HOLIDAYS = ["2026-10-12", "2026-11-23"];

describe("business days of Argentina [FL-070] [FL-076]", () => {
  it("reads the local date in UTC−03:00", () => {
    expect(localDateAr(new Date("2026-10-08T02:30:00Z"))).toBe("2026-10-07");
    expect(localDateAr(new Date("2026-10-08T03:00:00Z"))).toBe("2026-10-08");
  });

  it("does not count the filing day, weekends or holidays", () => {
    // Wednesday 07/10 10:10 → Thursday 08/10 is business day 1.
    const filed = new Date("2026-10-07T10:10:00-03:00");
    expect(nthBusinessDay(filed, 1, "10:00:00", HOLIDAYS).toISOString()).toBe("2026-10-08T13:00:00.000Z");
    // 09/10 Fri (2), 12/10 holiday, 13/10 Tue (3).
    expect(nthBusinessDay(filed, 3, "10:00:00", HOLIDAYS).toISOString()).toBe("2026-10-13T13:00:00.000Z");
  });

  it("sets the deadline at 23:59:59 of the 10th business day, with the three milestones", () => {
    const filed = new Date("2026-10-07T10:10:00-03:00");
    expect(deadline(filed, HOLIDAYS).toISOString()).toBe("2026-10-23T02:59:59.000Z");
    const at = milestones(filed, HOLIDAYS);
    expect(at.OPERATOR_REMINDER.toISOString()).toBe("2026-10-15T13:00:00.000Z");
    expect(at.SUPERVISOR_ESCALATION.toISOString()).toBe("2026-10-20T13:00:00.000Z");
    expect(at.DEADLINE).toEqual(deadline(filed, HOLIDAYS));
  });

  it("refuses a nonsensical count or time", () => {
    const filed = new Date("2026-10-07T10:10:00-03:00");
    expect(() => nthBusinessDay(filed, 0, "10:00:00", HOLIDAYS)).toThrow(RangeError);
    expect(() => nthBusinessDay(filed, 1, "10:00", HOLIDAYS)).toThrow(RangeError);
  });
});
