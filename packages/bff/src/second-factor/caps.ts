// The SMS caps on the real clock (docs/architecture-guests.md §17), with the counters of the sign-up
// (guests/caps.ts `takeAll`: read first, then a conditional `ADD` per counter, given back when a race
// fills a later one): per account (enrolment and sign-ins together), per number (only an enrolment to
// a number that is not yet the account's), per viewer IP and for the whole demo, all per real day.
import type { SignupCaps } from "../guests/caps";
import type { Counter } from "../guests/caps";
import { secondFactorRuntimeKeys } from "../leads/keys";
import { SECOND_FACTOR_LIMITS } from "../leads/limits";

export type SmsCapScope = "ACCOUNT" | "NUMBER" | "IP" | "GLOBAL";

interface ScopedCounter extends Counter {
  readonly scope: SmsCapScope;
}

export interface SmsSend {
  readonly sub: string;
  readonly ipHash: string;
  /** Present for an enrolment: the number's own cap counts too. */
  readonly enrolPhoneHash?: string;
}

/** Spends one SMS of every cap, or names the first one that is full and spends none. */
export async function takeSms(caps: Pick<SignupCaps, "count" | "takeAll">, send: SmsSend, at: Date): Promise<SmsCapScope | undefined> {
  const counters: ScopedCounter[] = [
    { scope: "ACCOUNT", key: secondFactorRuntimeKeys.accountDay(send.sub, at), limit: SECOND_FACTOR_LIMITS.smsPerAccountPerDay },
    ...(send.enrolPhoneHash ? [{ scope: "NUMBER" as const, key: secondFactorRuntimeKeys.numberDay(send.enrolPhoneHash, at), limit: SECOND_FACTOR_LIMITS.smsPerNumberPerDay }] : []),
    { scope: "IP", key: secondFactorRuntimeKeys.ipDay(send.ipHash, at), limit: SECOND_FACTOR_LIMITS.smsPerIpPerDay },
    { scope: "GLOBAL", key: secondFactorRuntimeKeys.globalDay(at), limit: SECOND_FACTOR_LIMITS.smsGlobalPerDay },
  ];
  const full = async (): Promise<SmsCapScope | undefined> => {
    const counts = await Promise.all(counters.map((counter) => caps.count(counter.key)));
    return counters.find((counter, index) => (counts[index] ?? 0) >= counter.limit)?.scope;
  };
  const before = await full();
  if (before) return before;
  if (await caps.takeAll(counters)) return undefined;
  return (await full()) ?? "GLOBAL";
}
