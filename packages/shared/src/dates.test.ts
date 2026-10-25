import { describe, expect, it } from "vitest";
import {
  CalendarDate,
  IsoInstant,
  addBusinessDays,
  addCalendarDays,
  businessDaysBetween,
  compareDates,
  formatDate,
  formatSimInstant,
  isBusinessDay,
  isWeekend,
  nextBusinessDay,
  weekStart,
  weekdayOf,
} from "./dates";

// A fixed, made-up holiday list: the real calendars are data of the seed (docs/seed-spec.md).
const HOLIDAYS = ["2026-10-12", "2026-11-23"];

describe("schemas", () => {
  it("accepts calendar dates and zoned instants only", () => {
    expect(CalendarDate.safeParse("2026-10-14").success).toBe(true);
    expect(CalendarDate.safeParse("2026-13-01").success).toBe(false);
    expect(IsoInstant.safeParse("2026-10-14T10:30:00-03:00").success).toBe(true);
    expect(IsoInstant.safeParse("not a date").success).toBe(false);
  });
});

describe("calendar helpers", () => {
  it("weekday and weekend", () => {
    expect(weekdayOf("2026-09-08")).toBe("TUE");
    expect(weekdayOf("2026-10-10")).toBe("SAT");
    expect(isWeekend("2026-10-11")).toBe(true);
    expect(isWeekend("2026-10-14")).toBe(false);
  });

  it("formats dd/mm/yyyy", () => {
    expect(formatDate("2026-10-22")).toBe("22/10/2026");
  });

  it("adds calendar days across month and year ends", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(compareDates("2026-10-20", "2026-10-22")).toBe(-1);
  });

  it("week starts on Monday", () => {
    expect(weekStart("2026-09-08")).toBe("2026-09-07");
    expect(weekStart("2026-09-13")).toBe("2026-09-07");
    expect(weekStart("2026-09-14")).toBe("2026-09-14");
  });
});

describe("business days", () => {
  it("weekends and holidays are not business days", () => {
    expect(isBusinessDay("2026-10-12", HOLIDAYS)).toBe(false);
    expect(isBusinessDay("2026-10-10", HOLIDAYS)).toBe(false);
    expect(isBusinessDay("2026-10-13", HOLIDAYS)).toBe(true);
  });

  it("counts business days strictly after the start day", () => {
    expect(addBusinessDays("2026-10-09", 1, HOLIDAYS)).toBe("2026-10-13");
    expect(addBusinessDays("2026-10-09", 0, HOLIDAYS)).toBe("2026-10-09");
    expect(businessDaysBetween("2026-10-09", "2026-10-16", HOLIDAYS)).toBe(4);
    expect(businessDaysBetween("2026-10-16", "2026-10-09", HOLIDAYS)).toBe(-4);
  });

  it("moves a deadline that falls on a weekend or holiday to the next business day", () => {
    expect(nextBusinessDay("2026-10-10", HOLIDAYS)).toBe("2026-10-13");
    expect(nextBusinessDay("2026-10-14", HOLIDAYS)).toBe("2026-10-14");
  });

  it("rejects negative or fractional day counts", () => {
    expect(() => addBusinessDays("2026-09-08", -1, HOLIDAYS)).toThrow(RangeError);
    expect(() => addBusinessDays("2026-09-08", 1.5, HOLIDAYS)).toThrow(RangeError);
  });

  it("shows a simulated instant in Argentina time, whatever offset it was written with", () => {
    expect(formatSimInstant("2026-10-07T10:10:00-03:00")).toBe("mié 07/10 10:10");
    expect(formatSimInstant("2026-10-07T13:15:00Z")).toBe("mié 07/10 10:15");
    expect(formatSimInstant("2026-10-11T02:30:00Z")).toBe("sáb 10/10 23:30");
    expect(() => formatSimInstant("mañana")).toThrow();
  });
});
