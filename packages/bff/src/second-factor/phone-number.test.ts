// The numbers the SMS code accepts (docs/architecture-guests.md §17.7, FL-131): E.164, no filler, a
// person's mobile, of a country of America, and which ones are of the home region.
import { describe, expect, it } from "vitest";
import { checkPhone } from "./phone-number";
import { AMERICA_PREFIXES, HOME_PREFIXES, NOT_PERSONAL_PREFIXES, isAmericaNumber, isHomeNumber } from "./phone-ranges";

describe("the numbers of the SMS code [FL-131]", () => {
  it.each(["+3197010203040", "+447012345678", "+88234567890", "+88312345678", "+870771234567", "+8816123456789", "+88812345678", "+97912345678"])("[FL-131] refuses %s as not a person's mobile", (phone) => {
    expect(checkPhone(phone)).toEqual({ ok: false, reason: "PHONE_NOT_ACCEPTED" });
  });

  it("[FL-131] keeps one list of the ranges refused", () => {
    expect(NOT_PERSONAL_PREFIXES).toEqual(["+3197", "+4470", "+882", "+883", "+870", "+881", "+888", "+979"]);
    expect(checkPhone("+12025550123")).toEqual({ ok: true, phone: "+12025550123" });
  });

  it.each(["+31612345678", "+447912345678", "+34612345678", "+358401234567", "+819012345678", "+8613812345678", "+919812345678", "+61412345678", "+27821234567"])("[FL-131] refuses %s: the SMS code goes only to countries of America", (phone) => {
    expect(checkPhone(phone)).toEqual({ ok: false, reason: "PHONE_COUNTRY_NOT_ALLOWED" });
  });

  it("[FL-131] America is +1 and +5, one list; +1 and +52 are accepted", () => {
    expect(AMERICA_PREFIXES).toEqual(["+1", "+5"]);
    for (const phone of ["+12025550123", "+14165550123", "+5215512345678", "+5352345678", "+50934567890", "+5491155550100"]) {
      expect(checkPhone(phone), phone).toEqual({ ok: true, phone });
      expect(isAmericaNumber(phone), phone).toBe(true);
    }
  });

  it.each(["+5491100000000", "+54 9 11 5555 5555 555", "+5491111111111", "+34600000000", "+12029999999"])("[FL-131] refuses the filler %s as INVALID_PHONE", (phone) => {
    expect(checkPhone(phone)).toEqual({ ok: false, reason: "INVALID_PHONE" });
  });

  it("[FL-131] six equal digits at the end are a real number", () => {
    expect(checkPhone("+54 9 11 5100-0000")).toEqual({ ok: true, phone: "+5491151000000" });
    expect(checkPhone("11 5555 0100")).toEqual({ ok: false, reason: "INVALID_PHONE" });
  });

  it("[FL-131] the home region: Latin America, one list, without Spain", () => {
    expect(HOME_PREFIXES).toEqual(["+54", "+55", "+56", "+57", "+52", "+51", "+598", "+595", "+591", "+593", "+58", "+506", "+507", "+502", "+503", "+504", "+505", "+1809", "+1829", "+1849"]);
    for (const phone of ["+5491155550100", "+5511987654321", "+56912345678", "+573001234567", "+5215512345678", "+51912345678", "+59899123456", "+595981123456", "+59171234567", "+593991234567", "+584121234567", "+50688123456", "+50761234567", "+50251234567", "+50371234567", "+50491234567", "+50581234567", "+18095551234", "+18295551234", "+18495551234"]) {
      expect(isHomeNumber(phone), phone).toBe(true);
    }
    for (const phone of ["+12025550123", "+5352345678", "+50934567890", "+18685551234", "+34612345678"]) expect(isHomeNumber(phone), phone).toBe(false);
  });
});
