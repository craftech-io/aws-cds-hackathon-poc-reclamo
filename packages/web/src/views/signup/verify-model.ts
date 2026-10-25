// Rules of `/signup/verify` without React (docs/landing-spec.md §9.3, FL-113 to FL-115): the
// 30-second wait between two codes (kept with the pending sign-up, so a reload does not reset it) and
// what each answer of `signup.confirm` and `signup.resend` does.
import type { SignupConfirmResult, SignupResendResult } from "../../lib/auth/public-api";

/** "Reenviar código" stays disabled this long after every code sent. */
export const RESEND_WAIT_MS = 30_000;

/** Whole seconds until another code may be asked for (0 = now). */
export function secondsUntilResend(resendAvailableAt: number, now: number): number {
  return Math.max(0, Math.ceil((resendAvailableAt - now) / 1_000));
}

export type ConfirmOutcome =
  /** The account exists and its world was asked for: sign in (silently when the password is still in memory). */
  | { readonly kind: "confirmed" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "expired" }
  /** Another form replaced this one, it expired, or the tab lost it: back to `/signup`. */
  | { readonly kind: "restart" }
  | { readonly kind: "rateLimited" };

export function confirmOutcome(answer: SignupConfirmResult): ConfirmOutcome {
  switch (answer.status) {
    case "CONFIRMED":
      return { kind: "confirmed" };
    case "CODE_MISMATCH":
      return { kind: "mismatch" };
    case "CODE_EXPIRED":
      return { kind: "expired" };
    case "SIGNUP_RESTART":
      return { kind: "restart" };
    case "RATE_LIMITED":
      return { kind: "rateLimited" };
  }
}

/** A resent code restarts the wait; a refusal leaves it as it was. */
export function afterResend(answer: SignupResendResult, now: number): { readonly sent: boolean; readonly resendAvailableAt?: number } {
  return answer.status === "CODE_SENT" ? { sent: true, resendAvailableAt: now + RESEND_WAIT_MS } : { sent: false };
}
