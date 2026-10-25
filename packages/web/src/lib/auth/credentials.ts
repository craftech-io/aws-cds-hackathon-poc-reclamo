// Client-side checks that mirror the pool (infra/auth.ts `PASSWORD_POLICY`: 12 characters, upper and
// lower case and a digit, no symbol required, docs/architecture-guests.md §2) so a person learns what
// is missing before the request goes out, and the otpauth URI the authenticator app scans. Cognito
// still enforces the policy; these are for the form, not for security.

export const PASSWORD_MIN_LENGTH = 12;

export type PasswordRule = "length" | "lower" | "upper" | "number";

const RULES: ReadonlyArray<readonly [PasswordRule, (password: string) => boolean]> = [
  ["length", (password) => [...password].length >= PASSWORD_MIN_LENGTH],
  ["lower", (password) => /\p{Ll}/u.test(password)],
  ["upper", (password) => /\p{Lu}/u.test(password)],
  ["number", (password) => /\d/.test(password)],
];

/** Rules of the pool's policy the password does not meet yet (empty = acceptable). */
export function missingPasswordRules(password: string): PasswordRule[] {
  return RULES.filter(([, test]) => !test(password)).map(([rule]) => rule);
}

/** Cognito rejects leading and trailing spaces in a password. */
export function hasOuterSpaces(password: string): boolean {
  return password !== password.trim();
}

/**
 * Usernames of the pool (docs/architecture.md §11): `operator-01`, `guest-03`, `qa-<runId>-…`, and
 * the email of a self-signup guest (docs/architecture-guests.md §1: the username IS the normalized
 * address, no alias). The pool is case-insensitive, so the form trims and lower-cases what is typed.
 */
export function normalizeUsername(username: string): string {
  return username.trim().normalize("NFC").toLowerCase();
}

/** A plain ASCII address with a dotted domain: what the form checks before the BFF's stricter rules. */
export function looksLikeEmail(value: string): boolean {
  const email = normalizeUsername(value);
  return email.length <= 254 && /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63}$/.test(email);
}

/** A staff or `guest-NN` username, or a self-signup guest's email. */
export function looksLikeUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalizeUsername(username)) || looksLikeEmail(username);
}

/** A six-digit TOTP code, after removing the spaces people type or paste. */
export function normalizeTotpCode(code: string): string | undefined {
  const digits = code.replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

export const TOTP_ISSUER = "Reclamo en regla";

/**
 * `otpauth://totp/Reclamo%20en%20regla:<username>?secret=…&issuer=…` (Key Uri Format): what Google
 * Authenticator, Microsoft Authenticator and 1Password scan. Rendered as a QR code locally; the
 * secret never leaves the page.
 */
export function otpauthUri(secret: string, account: string, issuer: string = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, "%20")}`;
}

/** The secret in groups of four, easier to type by hand when the camera is not an option. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
