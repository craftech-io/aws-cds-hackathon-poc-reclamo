import { describe, expect, it } from "vitest";
import { AUTH_COPY } from "../login/auth-copy";
import { PhoneStatus, SendCodeAnswer, VerifyAnswer, accountBlocked, codeOf, passed, secondsUntil, sendProblem, verifyProblem } from "./phone-model";

const errors = AUTH_COPY.es.phone.errors;

describe("the SMS-code screen [FL-129] [FL-130] [FL-131]", () => {
  it("[FL-130] opens the console only for a passed session or an automation account", () => {
    expect(passed(PhoneStatus.parse({ state: "PASSED" }))).toBe(true);
    expect(passed(PhoneStatus.parse({ state: "EXEMPT" }))).toBe(true);
    expect(passed(PhoneStatus.parse({ state: "ENROL", codeSent: false }))).toBe(false);
    expect(passed(PhoneStatus.parse({ state: "SIGN_IN", lastDigits: "0100", codeSent: true }))).toBe(false);
    expect(PhoneStatus.safeParse({ state: "SIGN_IN", lastDigits: "+5491155550100", codeSent: true }).success).toBe(false);
  });

  it("[FL-131] counts down the resend wait in whole seconds", () => {
    const now = Date.parse("2026-11-27T13:00:00.000Z");
    expect(secondsUntil("2026-11-27T13:00:42.300Z", now)).toBe(43);
    expect(secondsUntil("2026-11-27T12:59:00.000Z", now)).toBe(0);
    expect(secondsUntil(undefined, now)).toBe(0);
  });

  it("[FL-131] gives every refusal its fixed text, with the contact link where a person cannot fix it alone", () => {
    expect(sendProblem(SendCodeAnswer.parse({ status: "RATE_LIMITED", limit: "ACCOUNT" }), errors)).toEqual({ text: errors.accountLimit, contact: true });
    expect(sendProblem(SendCodeAnswer.parse({ status: "RATE_LIMITED", limit: "IP" }), errors)).toEqual({ text: errors.rateLimited, contact: true });
    expect(sendProblem(SendCodeAnswer.parse({ status: "PHONE_IN_USE" }), errors)?.text).toBe("Ese número ya está en uso en otra cuenta.");
    expect(sendProblem(SendCodeAnswer.parse({ status: "SMS_FAILED" }), errors)).toEqual({ text: errors.smsFailed, contact: true });
    expect(sendProblem(SendCodeAnswer.parse({ status: "PHONE_LOCKED" }), errors)?.contact).toBe(true);
    expect(sendProblem(SendCodeAnswer.parse({ status: "INVALID_PHONE" }), errors)).toEqual({ text: errors.invalidPhone, contact: false });
    expect(sendProblem(SendCodeAnswer.parse({ status: "PHONE_NOT_ACCEPTED" }), errors)).toEqual({ text: "Usá un celular personal.", contact: false });
    expect(sendProblem(SendCodeAnswer.parse({ status: "PHONE_COUNTRY_NOT_ALLOWED" }), errors)).toEqual({ text: "Por ahora solo aceptamos celulares de países de América. Si necesitás acceso, escribinos.", contact: true });
    expect(sendProblem(SendCodeAnswer.parse({ status: "RATE_LIMITED", limit: "ABROAD" }), errors)).toEqual({ text: errors.abroadLimit, contact: true });
    expect(sendProblem(SendCodeAnswer.parse({ status: "CODE_SENT", purpose: "SIGN_IN", lastDigits: "0100", resendAvailableAtReal: "2026-11-27T13:01:00.000Z" }), errors)).toBeUndefined();
    expect(verifyProblem(VerifyAnswer.parse({ status: "CODE_MISMATCH", attemptsLeft: 3 }), errors)?.text).toBe("Ese código no es correcto. Te quedan 3 intentos.");
    expect(verifyProblem(VerifyAnswer.parse({ status: "CODE_MISMATCH", attemptsLeft: 0 }), errors)?.text).toBe(errors.burnt);
    expect(verifyProblem(VerifyAnswer.parse({ status: "CODE_EXPIRED" }), errors)?.text).toBe(errors.expired);
    expect(verifyProblem(VerifyAnswer.parse({ status: "VERIFIED" }), errors)).toBeUndefined();
  });

  it("[FL-132] tells a blocked account apart, with its notice in both languages", () => {
    expect(accountBlocked("ACCOUNT_BLOCKED")).toBe(true);
    expect(accountBlocked("STAFF_INACTIVE")).toBe(false);
    expect(accountBlocked(null)).toBe(false);
    expect(AUTH_COPY.es.phone.blocked.title).toBe("Tu cuenta está bloqueada");
    expect(AUTH_COPY.en.phone.blocked.title).toBe("Your account is blocked");
  });

  it("reads six digits from what was typed or pasted", () => {
    expect(codeOf(" 482 913 ")).toBe("482913");
    expect(codeOf("48291")).toBeUndefined();
  });

  it("names the countries where SMS cannot arrive yet, in both languages", () => {
    expect(AUTH_COPY.es.phone.errors.smsFailed).toContain("Estados Unidos e India");
    expect(AUTH_COPY.en.phone.errors.smsFailed).toContain("the United States and India");
  });
});
