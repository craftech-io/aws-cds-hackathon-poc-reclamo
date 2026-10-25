// What travels between the access screens of one tab (docs/landing-spec.md §9.3, §9.6):
//   - the sign-up in progress (`signupId`, the email it was sent to and when another code may be
//     asked for) in sessionStorage, never in the URL, so `/signup/verify` survives a reload; after
//     the confirmation only the email stays, for the login's "account confirmed" notice; it dies
//     with the tab and is cleared by a finished sign-in;
//   - the password typed on `/signup`, ONLY in this module's memory, for the silent sign-in after
//     the code: never in any storage, gone on a reload;
//   - the email the login pre-fills after a password reset, in memory too.
// Nothing here goes to a URL or a log. Storage may be blocked (a private window): every access is
// guarded and the screens fall back to asking again.
import { z } from "zod";

const PENDING_KEY = "reclamo.signup.pending";

const PendingSignup = z.object({
  /** Absent once the code was confirmed. */
  signupId: z.string().regex(/^[a-z2-7]{26}$/).optional(),
  email: z.string().min(3).max(254),
  /** Epoch ms from which another code may be asked for. */
  resendAvailableAt: z.number().int().nonnegative(),
  confirmed: z.boolean().optional(),
});
export type PendingSignup = z.infer<typeof PendingSignup>;

function session(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function savePendingSignup(pending: PendingSignup): void {
  try {
    session()?.setItem(PENDING_KEY, JSON.stringify(PendingSignup.parse(pending)));
  } catch {
    // Not kept: a reload of /signup/verify sends the person back to /signup.
  }
}

export function readPendingSignup(): PendingSignup | undefined {
  try {
    const raw = session()?.getItem(PENDING_KEY);
    if (!raw) return undefined;
    const parsed = PendingSignup.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSignup(): void {
  try {
    session()?.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The code was accepted: the `signupId` is spent, the email stays for the login's notice. */
export function markSignupConfirmed(email: string): void {
  savePendingSignup({ email, resendAvailableAt: 0, confirmed: true });
}

interface Memory {
  password?: string;
  loginEmail?: string;
}

const memory: Memory = {};

/** The password typed on /signup, for the silent sign-in after the code. Memory only. */
export function holdPassword(password: string): void {
  memory.password = password;
}

export function heldPassword(): string | undefined {
  return memory.password;
}

export function forgetPassword(): void {
  delete memory.password;
}

/** The email `/login` pre-fills after a password reset. */
export function holdLoginEmail(email: string): void {
  memory.loginEmail = email;
}

/** What `/login` pre-fills: the email of a reset, or of a sign-up confirmed in this tab. */
export function loginEmailHint(): string | undefined {
  if (memory.loginEmail !== undefined) return memory.loginEmail;
  const pending = readPendingSignup();
  return pending?.confirmed ? pending.email : undefined;
}

/** A finished sign-in: nothing of the sign-up or the reset is needed any more. */
export function forgetAccessHandoff(): void {
  clearPendingSignup();
  forgetPassword();
  delete memory.loginEmail;
}
