// Hashes of the SMS code (docs/architecture-guests.md §17), keyed by `PhoneHashKey` with their own HKDF
// subkeys (lib/crypto.ts): a number becomes `phoneHash` before it enters a key, a code is stored only as
// its HMAC (bound to the account, the session that asked for it and the instant it was sent), and a
// sign-in session (`origin_jti`, or `auth_time` when the token has none) only as `sessionHash`.
import { type SecretKey, deriveSubkey, hmacSha256Hex } from "../lib/crypto";
import { leadHashes } from "../leads/keys";

export interface SecondFactorHashes {
  phoneHash(phone: string): string;
  codeHash(input: { readonly sub: string; readonly sessionHash: string; readonly sentAtReal: string; readonly code: string }): string;
  sessionHash(sub: string, signInKey: string): string;
  ipHash(viewerIp: string): string;
}

export function secondFactorHashes(phoneHashKey: SecretKey): SecondFactorHashes {
  const phone = deriveSubkey("PhoneHashKey", phoneHashKey, "account-phone");
  const code = deriveSubkey("PhoneHashKey", phoneHashKey, "phone-code");
  const session = deriveSubkey("PhoneHashKey", phoneHashKey, "second-factor");
  const { ipHash } = leadHashes(phoneHashKey);
  return {
    phoneHash: (value) => hmacSha256Hex(phone, value),
    codeHash: (input) => hmacSha256Hex(code, [input.sub, input.sessionHash, input.sentAtReal, input.code].join("|")),
    sessionHash: (sub, signInKey) => hmacSha256Hex(session, `${sub}|${signInKey}`),
    ipHash,
  };
}
