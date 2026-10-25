// The secrets of an in-process world, as test values: the stage reads `SessionKey`, `PhoneHashKey`,
// `RegisterChainKey`, `SimEnvelopeKey`, `QaSimEnvelopeKey` and `EdgeOriginKey` from `sst.Secret`
// (infra/secrets.ts); the local flows and the local UI server use these instead. None of them is, or
// ever was, a stage value: they only have to be long enough for the code that derives from them.
import { addressHash } from "@reclamo/shared";
import { deriveSubkey } from "@reclamo/bff/lib/crypto";

export const LOCAL_KEYS = {
  session: "local-flows-session-key-not-a-secret-0123456789abcdef",
  phoneHash: "local-flows-phone-hash-key-not-a-secret-0123456789abc",
  registerChain: "local-flows-register-chain-key-not-a-secret-0123456789",
  simEnvelope: {
    console: "local-flows-console-sim-envelope-key-not-a-secret-01",
    qa: "local-flows-qa-sim-envelope-key-not-a-secret-0123456789",
  },
  edgeOrigin: "local-flows-edge-origin-key-not-a-secret-0123456789ab",
} as const;

/** `PhoneHashKey` → `phone-hash`: the customer's number as the inbound adapter and the core hash it. */
export const PHONE_HASH_SUBKEY = deriveSubkey("PhoneHashKey", LOCAL_KEYS.phoneHash, "phone-hash");

/** `PhoneHashKey` → `email-hash`. */
export const EMAIL_HASH_SUBKEY = deriveSubkey("PhoneHashKey", LOCAL_KEYS.phoneHash, "email-hash");

export function phoneHashOf(phoneE164: string): Promise<string> {
  return addressHash("WHATSAPP", phoneE164, PHONE_HASH_SUBKEY);
}
