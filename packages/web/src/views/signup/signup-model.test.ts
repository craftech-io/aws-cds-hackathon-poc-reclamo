import { describe, expect, it } from "vitest";
import { EMPTY_SIGNUP, draftOf, firstErrorField, formFromDraft, startInputOf, startOutcome, validateSignup } from "./signup-model";
import { afterResend, confirmOutcome, RESEND_WAIT_MS, secondsUntilResend } from "./verify-model";

const VALID = { ...EMPTY_SIGNUP, email: " Success+QA-run1-su1@simulator.amazonses.com ", password: "UnaClaveLarga2026", acceptTerms: true };

describe("the sign-up form [FL-112] [FL-116] [FL-118]", () => {
  it("starts with both consents unticked and refuses a form without the required one", () => {
    expect(EMPTY_SIGNUP.acceptTerms).toBe(false);
    expect(EMPTY_SIGNUP.acceptContact).toBe(false);
    expect(validateSignup({ ...VALID, acceptTerms: false })).toEqual({ acceptTerms: "consent" });
  });

  it("asks 12 characters with upper and lower case and a digit, and a plain email", () => {
    expect(validateSignup(VALID)).toEqual({});
    expect(validateSignup({ ...VALID, password: "corta1A" })).toEqual({ password: "weakPassword" });
    expect(validateSignup({ ...VALID, password: "sinmayusculas2026" })).toEqual({ password: "weakPassword" });
    expect(validateSignup({ ...VALID, email: "no-es-un-email" }).email).toBe("email");
  });

  it("refuses links and markup in the optional texts, as the BFF does", () => {
    expect(validateSignup({ ...VALID, name: "Ana <b>" }).name).toBe("plainText");
    expect(validateSignup({ ...VALID, company: "visitanos en www.algo" }).company).toBe("plainText");
    expect(validateSignup({ ...VALID, company: "Prestamista del Sur" })).toEqual({});
  });

  it("announces the first field with an error, in the order of the form", () => {
    expect(firstErrorField({ acceptTerms: "consent", password: "weakPassword" })).toBe("password");
    expect(firstErrorField({})).toBeUndefined();
  });

  it("sends the form, the screen's language and only the visit's campaign and referrer", () => {
    const input = startInputOf({ ...VALID, name: "  ", jobTitle: "Producto", acceptContact: true }, "en", { utm: { source: "news", campaign: "launch" }, referrer: "https://news.example.com" });
    expect(input).toEqual({
      email: "Success+QA-run1-su1@simulator.amazonses.com",
      password: "UnaClaveLarga2026",
      jobTitle: "Producto",
      acceptTerms: true,
      acceptContact: true,
      locale: "en",
      utm: { source: "news", campaign: "launch" },
      referrer: "https://news.example.com",
    });
    expect(startInputOf(VALID, "es", {})).not.toHaveProperty("utm");
  });

  it("maps every answer of signup.start to what the screen does", () => {
    expect(startOutcome({ status: "CODE_SENT", signupId: "abcdefghijklmnopqrstuvwxyz" })).toEqual({ kind: "codeSent", signupId: "abcdefghijklmnopqrstuvwxyz" });
    expect(startOutcome({ status: "EMAIL_TAKEN" })).toEqual({ kind: "taken" });
    expect(startOutcome({ status: "EMAIL_NOT_ACCEPTED" })).toEqual({ kind: "fieldErrors", errors: { email: "notAccepted" } });
    expect(startOutcome({ status: "RATE_LIMITED" })).toEqual({ kind: "rateLimited" });
    expect(startOutcome({ status: "SIGNUP_UNAVAILABLE" })).toEqual({ kind: "closed" });
    expect(startOutcome({ status: "CONSENT_REQUIRED" })).toEqual({ kind: "fieldErrors", errors: { acceptTerms: "consent" } });
  });

  it("keeps everything but the password across a firewall reload, and re-checks what comes back", () => {
    const draft = draftOf({ ...VALID, acceptContact: true });
    expect(draft).not.toHaveProperty("password");
    expect(formFromDraft(JSON.parse(JSON.stringify(draft)))).toEqual({ ...VALID, password: "", acceptContact: true });
    expect(formFromDraft({ email: 3, acceptTerms: "yes" })).toEqual(EMPTY_SIGNUP);
  });
});

describe("the code of the sign-up [FL-113] [FL-114] [FL-115]", () => {
  it("waits 30 s between two codes", () => {
    expect(secondsUntilResend(10_000 + RESEND_WAIT_MS, 10_000)).toBe(30);
    expect(secondsUntilResend(40_000, 39_001)).toBe(1);
    expect(secondsUntilResend(40_000, 41_000)).toBe(0);
    expect(afterResend({ status: "CODE_SENT" }, 5_000)).toEqual({ sent: true, resendAvailableAt: 5_000 + RESEND_WAIT_MS });
    expect(afterResend({ status: "RATE_LIMITED" }, 5_000)).toEqual({ sent: false });
  });

  it("maps every answer of signup.confirm", () => {
    expect(confirmOutcome({ status: "CONFIRMED", worldStatus: "REGISTERED", email: "x@y.ar" })).toEqual({ kind: "confirmed" });
    expect(confirmOutcome({ status: "CODE_MISMATCH" })).toEqual({ kind: "mismatch" });
    expect(confirmOutcome({ status: "CODE_EXPIRED" })).toEqual({ kind: "expired" });
    expect(confirmOutcome({ status: "SIGNUP_RESTART" })).toEqual({ kind: "restart" });
    expect(confirmOutcome({ status: "RATE_LIMITED" })).toEqual({ kind: "rateLimited" });
  });
});
