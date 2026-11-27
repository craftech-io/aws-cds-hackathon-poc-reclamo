// The numbers the SMS code accepts (docs/architecture-guests.md §17.7, FL-131): E.164, no filler, a
// person's mobile, and which ones are of the home region.
import { describe, expect, it } from "vitest";
import { checkPhone } from "./phone-number";
import { HOME_PREFIXES, NOT_PERSONAL_PREFIXES, isHomeNumber } from "./phone-ranges";

describe("the numbers of the SMS code [FL-131]", () => {
  it.each(["+3197010203040", "+447012345678", "+88234567890", "+88312345678", "+870771234567", "+8816123456789", "+88812345678", "+97912345678"])("[FL-131] refuses %s as not a person's mobile", (phone) => {
    expect(checkPhone(phone)).toEqual({ ok: false, reason: "PHONE_NOT_ACCEPTED" });
  });

  it("[FL-131] keeps one list of the ranges refused", () => {
    expect(NOT_PERSONAL_PREFIXES).toEqual(["+3197", "+4470", "+882", "+883", "+870", "+881", "+888", "+979"]);
    expect(checkPhone("+31612345678")).toEqual({ ok: true, phone: "+31612345678" });
    expect(checkPhone("+447912345678")).toEqual({ ok: true, phone: "+447912345678" });
  });

  it.each(["+5491100000000", "+54 9 11 5555 5555 555", "+5491111111111", "+34600000000", "+12029999999"])("[FL-131] refuses the filler %s as INVALID_PHONE", (phone) => {
    expect(checkPhone(phone)).toEqual({ ok: false, reason: "INVALID_PHONE" });
  });

  it("[FL-131] six equal digits at the end are a real number", () => {
    expect(checkPhone("+54 9 11 5100-0000")).toEqual({ ok: true, phone: "+5491151000000" });
    expect(checkPhone("11 5555 0100")).toEqual({ ok: false, reason: "INVALID_PHONE" });
  });

  it("[FL-131] the home region: Latin America and Spain, one list", () => {
    expect(HOME_PREFIXES).toEqual(["+54", "+55", "+56", "+57", "+52", "+51", "+598", "+595", "+591", "+593", "+58", "+506", "+507", "+502", "+503", "+504", "+505", "+1809", "+1829", "+1849", "+34"]);
    for (const phone of ["+5491155550100", "+5511987654321", "+56912345678", "+573001234567", "+5215512345678", "+51912345678", "+59899123456", "+595981123456", "+59171234567", "+593991234567", "+584121234567", "+50688123456", "+50761234567", "+50251234567", "+50371234567", "+50491234567", "+50581234567", "+18095551234", "+18295551234", "+18495551234", "+34612345678"]) {
      expect(isHomeNumber(phone), phone).toBe(true);
    }
    for (const phone of ["+12025550123", "+358401234567", "+31612345678", "+5352345678", "+18685551234", "+447912345678"]) expect(isHomeNumber(phone), phone).toBe(false);
  });
});
