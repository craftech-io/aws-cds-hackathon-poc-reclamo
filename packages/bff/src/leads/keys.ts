// Keys of the self-signup (docs/architecture-guests.md §10-§11) and the hashes they are built from.
// The `Leads` table has no world: its partitions are `SIGNUP#`, `PENDING#`, `CANON#`, `LEAD#` and
// `LEADDEL#` (with `QA…` twins for the scenario runner). The global counters of the sign-up live in
// `Runtime` under their own prefixes, which the Bff's leading-key fence names one by one.
//
// An email never enters a key: `emailHash` is an HMAC of the normalized literal address (uniqueness,
// the current request, recovery, deletion) and `canonHash` of its canonical form (the caps). A viewer
// IP is only ever stored as `ipHash`, of its /64 prefix for IPv6. The world of an account is derived
// from its Cognito `sub`, so an expired world comes back with the same id.
import { createHmac } from "node:crypto";
import { isIPv6 } from "node:net";
import { ConnectorError } from "@reclamo/shared";
import { segment } from "../connector/keys";
import type { Key } from "../connector/store";
import { type SecretKey, deriveSubkey, hmacSha256Hex } from "../lib/crypto";

export const META = "META";

/** A self-signup run by the scenario runner (`success+qa-<runId>-<key>@simulator.amazonses.com`). */
export interface QaScope {
  readonly runId: string;
  /** `su1`, `su2`… */
  readonly key: string;
}

const qaPart = (scope: QaScope | undefined, prefix: string, qaPrefix: string): string =>
  scope === undefined ? `${prefix}#` : `${qaPrefix}#${segment(scope.runId, "qa run id")}#`;

export const leadsKeys = {
  signup: (signupId: string, qa?: QaScope): Key => ({ pk: `${qaPart(qa, "SIGNUP", "QASIGNUP")}${segment(signupId, "signup id")}`, sk: META }),
  pending: (emailHash: string, qa?: QaScope): Key => ({ pk: `${qaPart(qa, "PENDING", "QAPENDING")}${segment(emailHash, "email hash")}`, sk: META }),
  canon: (canonHash: string): Key => ({ pk: `CANON#${segment(canonHash, "canonical hash")}`, sk: META }),
  lead: (sub: string, qa?: QaScope): Key => ({ pk: `${qaPart(qa, "LEAD", "QALEAD")}${segment(sub, "cognito sub")}`, sk: META }),
  deleted: (emailHash: string, at: Date): Key => ({ pk: `LEADDEL#${segment(emailHash, "email hash")}`, sk: at.toISOString() }),
  emailHashKey: (emailHash: string): string => `EMAIL#${segment(emailHash, "email hash")}`,
  subKey: (sub: string): string => `SUB#${segment(sub, "cognito sub")}`,
};

/** `2026-10-07T13` and `2026-10-07` (UTC) of a real instant. */
export const realHour = (at: Date): string => at.toISOString().slice(0, 13);
export const realDay = (at: Date): string => at.toISOString().slice(0, 10);
export const realMonth = (at: Date): string => at.toISOString().slice(0, 7);

/** Global items of `Runtime` the sign-up reads and counts (never under a world). */
export const signupRuntimeKeys = {
  switch: (): Key => ({ pk: "SWITCH#SIGNUP", sk: META }),
  kill: (): Key => ({ pk: "KILL#SIGNUP", sk: META }),
  globalHour: (at: Date): Key => ({ pk: `SIGNUPCAP#${realHour(at)}`, sk: META }),
  globalDay: (at: Date): Key => ({ pk: `SIGNUPCAP#${realDay(at)}`, sk: META }),
  /** The scenario runner's own sign-up buckets (`caps.prime SIGNUP_QA`). */
  qaHour: (at: Date): Key => ({ pk: `SIGNUPCAP#QA#${realHour(at)}`, sk: META }),
  qaDay: (at: Date): Key => ({ pk: `SIGNUPCAP#QA#${realDay(at)}`, sk: META }),
  ipDay: (ipHash: string, at: Date): Key => ({ pk: `SIGNUPIP#${segment(ipHash, "ip hash")}#${realDay(at)}`, sk: META }),
  canonDay: (canonHash: string, at: Date): Key => ({ pk: `SIGNUPCANON#${segment(canonHash, "canonical hash")}#${realDay(at)}`, sk: META }),
  authMailHour: (at: Date): Key => ({ pk: `AUTHMAIL#${realHour(at)}`, sk: META }),
  authMailDay: (at: Date): Key => ({ pk: `AUTHMAIL#${realDay(at)}`, sk: META }),
  accountHour: (sub: string, kind: "RESEND" | "RECOVERY", at: Date): Key => ({ pk: `GUESTACCT#${segment(sub, "cognito sub")}#${kind}#${realHour(at)}`, sk: META }),
  accountDay: (sub: string, kind: "RESEND" | "RECOVERY", at: Date): Key => ({ pk: `GUESTACCT#${segment(sub, "cognito sub")}#${kind}#${realDay(at)}`, sk: META }),
  worldRequest: (sub: string): Key => ({ pk: `GUESTACCT#${segment(sub, "cognito sub")}#WORLDREQ`, sk: META }),
  recoveryIpHour: (ipHash: string, at: Date): Key => ({ pk: `RECOVERYIP#${segment(ipHash, "ip hash")}#${realHour(at)}`, sk: META }),
  leadNoticeDay: (at: Date): Key => ({ pk: `LEADNOTICE#${realDay(at)}`, sk: META }),
};

/**
 * Partition of the audit entries of the public edge that belong to no world (never an email); the
 * scenario runner's (`qa`) have their own, so a QA run never writes among a visitor's entries.
 */
export const signupAuditPartition = (at: Date, qa = false): string => `SIGNUP#AUD#${qa ? "QA#" : ""}${realMonth(at)}`;

const QA_SIGNUP_WORLD = /^qa-([a-z0-9]+(?:-[a-z0-9]+)*)-(su\d{1,3})$/;

/** The QA scope of a scenario runner's sign-up world `qa-<runId>-su<n>` (§3), or `undefined` for any other. */
export function qaScopeOfWorld(worldId: string): QaScope | undefined {
  const match = QA_SIGNUP_WORLD.exec(worldId);
  if (!match?.[1] || !match[2] || match[1].length > 24) return undefined;
  return { runId: match[1], key: match[2] };
}

// ---- Hashes ------------------------------------------------------------------------------------

export interface LeadHashes {
  emailHash(normalizedEmail: string): string;
  canonHash(canonicalEmail: string): string;
  ipHash(viewerIp: string): string;
  /** `gs-<10 base32>` of an account: stable, so an expired world is recreated with the same id. */
  guestWorldId(sub: string): string;
}

/** The part of an IP that identifies one subscriber: the address for IPv4, the /64 for IPv6. */
export function subscriberPrefix(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (!isIPv6(value)) return value;
  const [head = "", tail = ""] = value.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = value.includes("::") ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, no padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "a";
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? "a";
  return out;
}

export const GUEST_WORLD_PATTERN = /^gs-[a-z2-7]{10}$/;

/** Hashes keyed by `PhoneHashKey`, each with its own HKDF subkey (lib/crypto.ts). */
export function leadHashes(phoneHashKey: SecretKey): LeadHashes {
  const leadEmail = deriveSubkey("PhoneHashKey", phoneHashKey, "lead-email");
  const signupIp = deriveSubkey("PhoneHashKey", phoneHashKey, "signup-ip");
  const guestWorld = deriveSubkey("PhoneHashKey", phoneHashKey, "guest-world");
  return {
    emailHash: (email) => hmacSha256Hex(leadEmail, `literal:${email}`),
    canonHash: (email) => hmacSha256Hex(leadEmail, `canonical:${email}`),
    ipHash: (ip) => hmacSha256Hex(signupIp, subscriberPrefix(ip)),
    guestWorldId: (sub) => {
      if (!sub) throw new ConnectorError("VALIDATION", "a guest world needs a sub");
      return `gs-${base32(createHmac("sha256", guestWorld).update(sub).digest()).slice(0, 10)}`;
    },
  };
}
