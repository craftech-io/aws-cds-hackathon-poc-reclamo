/// <reference path="../../sst-env.d.ts" />
// Linked `sst.Secret` values (infra/secrets.ts), read through `Resource` (never `process.env`). Kept
// apart from lib/crypto.ts so the primitives stay pure and testable without an SST link. One secret
// per purpose (docs/architecture.md §3): a function reads only the ones linked to it.
import { Resource } from "sst";
import { z } from "zod";
import { ToolError } from "@reclamo/shared";

export const SECRET_NAMES = [
  "SessionKey",
  "SimEnvelopeKey",
  "QaSimEnvelopeKey",
  "PhoneHashKey",
  "RegisterChainKey",
  "WabaId",
  "WhatsAppPhoneNumberId",
  "SeedOverrides",
  // Guest self-signup (docs/architecture-guests.md §13): the one @craftech.io mailbox of the lead
  // notices (`not-configured` until the CTO sets it) and the header the Router adds to /api/*.
  "LeadNotifyEmail",
  "EdgeOriginKey",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** The secrets that are keys (32 random bytes in base64); the rest are ids or JSON. */
export const KEY_SECRETS = ["SessionKey", "SimEnvelopeKey", "QaSimEnvelopeKey", "PhoneHashKey", "RegisterChainKey", "EdgeOriginKey"] as const satisfies readonly SecretName[];
export type KeySecretName = (typeof KEY_SECRETS)[number];

const SecretResource = z.object({ value: z.string().min(1) });
const cache = new Map<SecretName, string>();

export function secretValue(name: SecretName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let raw: unknown;
  try {
    // `Resource` is a Proxy that throws for anything not linked to this function.
    raw = Reflect.get(Resource, name);
  } catch (error) {
    throw new ToolError("UNAVAILABLE", `secret "${name}" is not linked to this function`, undefined, { cause: error });
  }
  const parsed = SecretResource.safeParse(raw);
  if (!parsed.success) throw new ToolError("UNAVAILABLE", `secret "${name}" has no value in this stage`);
  cache.set(name, parsed.data.value);
  return parsed.data.value;
}

// A key is 32 random bytes in base64 (44 characters); anything shorter weakens every subkey derived
// from it, so fail loudly instead of signing.
const MIN_KEY_LENGTH = 32;

/** The value of a key secret, refused when it is too short to be one. */
export function keySecret(name: KeySecretName): string {
  const key = secretValue(name);
  if (key.length < MIN_KEY_LENGTH) throw new ToolError("UNAVAILABLE", `${name} must have at least ${MIN_KEY_LENGTH} characters`);
  return key;
}

/** Test seam. */
export function resetSecretCache(): void {
  cache.clear();
}
