// Abuse caps of the self-signup on the REAL clock (docs/architecture-guests.md §7): one counter per
// window in `Runtime`, incremented with `ADD` only while it is below its limit, so the count never
// passes the cap however many requests race. The global auth-mail cap (`AUTHMAIL#`) is read before a
// decision and counted only when Cognito is about to be called, so a refusal that never reaches
// Cognito does not spend it, and its state is global: it never says whether an account exists.
import { ConnectorError } from "@reclamo/shared";
import type { RepoContext } from "../connector/codec";
import type { Key } from "../connector/store";
import { cond } from "../connector/store";
import { signupRuntimeKeys } from "../leads/keys";
import { LEADS_TTL_SECONDS, SIGNUP_LIMITS, expiresAt } from "../leads/limits";

const TABLE = "Runtime" as const;

/**
 * `KILL#SIGNUP` is on while its row exists, whatever it holds and whoever wrote it (the budget, the SES
 * reputation alarms), like `KILL#AGENT`; only the operator's `guests:signup-switch -- --on` deletes it.
 */
export function signupKilled(kill: Readonly<Record<string, unknown>> | undefined): boolean {
  return kill !== undefined;
}

export interface Counter {
  readonly key: Key;
  readonly limit: number;
}

export function signupCaps(ctx: RepoContext) {
  const count = async (key: Key): Promise<number> => {
    const item = await ctx.store.get(TABLE, key, { consistent: true });
    return typeof item?.count === "number" ? item.count : 0;
  };

  /** One more in the window unless it reached its limit; `false` when it did. */
  const take = async ({ key, limit }: Counter): Promise<boolean> => {
    const now = ctx.now();
    try {
      await ctx.store.write({
        kind: "update",
        table: TABLE,
        key,
        condition: cond.or(cond.notExists("count"), cond.lt("count", limit)),
        update: { add: { count: 1 }, set: { entity: "CapCounter", updatedAt: now.toISOString(), expiresAt: expiresAt(now, LEADS_TTL_SECONDS.counter) } },
      });
      return true;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
      throw error;
    }
  };

  /** Gives back one unit taken by a request that another counter then refused. */
  const giveBack = async ({ key }: Counter): Promise<void> => {
    try {
      await ctx.store.write({ kind: "update", table: TABLE, key, condition: cond.gt("count", 0), update: { add: { count: -1 } } });
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    }
  };

  /**
   * All or nothing: reads every counter first and refuses without spending any when one is full;
   * then takes them in order (narrowest first) and gives back what it took if a race filled a later
   * one. A refused request never spends a unit of a wider cap.
   */
  const takeAll = async (counters: readonly Counter[]): Promise<boolean> => {
    const counts = await Promise.all(counters.map((counter) => count(counter.key)));
    if (counters.some((counter, index) => (counts[index] ?? 0) >= counter.limit)) return false;
    const taken: Counter[] = [];
    for (const counter of counters) {
      if (await take(counter)) {
        taken.push(counter);
        continue;
      }
      for (const done of taken) await giveBack(done);
      return false;
    }
    return true;
  };

  const authMail = (at: Date): Counter[] => [
    { key: signupRuntimeKeys.authMailHour(at), limit: SIGNUP_LIMITS.authMailPerHour },
    { key: signupRuntimeKeys.authMailDay(at), limit: SIGNUP_LIMITS.authMailPerDay },
  ];

  return {
    take,
    takeAll,
    count,

    /** Room left in the global auth-mail cap (read only). */
    async authMailOpen(): Promise<boolean> {
      const counters = authMail(ctx.now());
      const counts = await Promise.all(counters.map((counter) => count(counter.key)));
      return counters.every((counter, index) => (counts[index] ?? 0) < counter.limit);
    },
    /** Spends one auth mail, right before Cognito sends it. */
    spendAuthMail: () => takeAll(authMail(ctx.now())),

    /** Per IP, per canonical email and global caps of `signup.start`, the narrow ones first. */
    signupRequest: (ipHash: string, canonHash: string) => {
      const at = ctx.now();
      return takeAll([
        { key: signupRuntimeKeys.ipDay(ipHash, at), limit: SIGNUP_LIMITS.perIpPerDay },
        { key: signupRuntimeKeys.canonDay(canonHash, at), limit: SIGNUP_LIMITS.perCanonicalEmailPerDay },
        { key: signupRuntimeKeys.globalHour(at), limit: SIGNUP_LIMITS.globalPerHour },
        { key: signupRuntimeKeys.globalDay(at), limit: SIGNUP_LIMITS.globalPerDay },
      ]);
    },

    /** The scenario runner's sign-ups (`SIGNUPCAP#QA#…`), apart from every visitor's bucket. */
    qaSignupRequest: () => {
      const at = ctx.now();
      return takeAll([
        { key: signupRuntimeKeys.qaHour(at), limit: SIGNUP_LIMITS.globalPerHour },
        { key: signupRuntimeKeys.qaDay(at), limit: SIGNUP_LIMITS.globalPerDay },
      ]);
    },

    /** Resends of one account. */
    resend: (sub: string) => {
      const at = ctx.now();
      return takeAll([
        { key: signupRuntimeKeys.accountHour(sub, "RESEND", at), limit: SIGNUP_LIMITS.resendPerHour },
        { key: signupRuntimeKeys.accountDay(sub, "RESEND", at), limit: SIGNUP_LIMITS.resendPerDay },
      ]);
    },

    /** Recoveries from one IP (before anything is known about the email). */
    recoveryFromIp: (ipHash: string) => take({ key: signupRuntimeKeys.recoveryIpHour(ipHash, ctx.now()), limit: SIGNUP_LIMITS.recoveryPerIpPerHour }),

    /** Recoveries of one account. */
    recoveryOfAccount: (sub: string) => {
      const at = ctx.now();
      return takeAll([
        { key: signupRuntimeKeys.accountHour(sub, "RECOVERY", at), limit: SIGNUP_LIMITS.recoveryPerHour },
        { key: signupRuntimeKeys.accountDay(sub, "RECOVERY", at), limit: SIGNUP_LIMITS.recoveryPerDay },
      ]);
    },

    /** Lead notices of the day. */
    leadNotice: () => take({ key: signupRuntimeKeys.leadNoticeDay(ctx.now()), limit: SIGNUP_LIMITS.leadNoticesPerDay }),

    /** `SWITCH#SIGNUP` open and `KILL#SIGNUP` off; a missing switch reads closed (fail closed). */
    async signupOpen(): Promise<boolean> {
      const [gate, kill] = await Promise.all([ctx.store.get(TABLE, signupRuntimeKeys.switch(), { consistent: true }), ctx.store.get(TABLE, signupRuntimeKeys.kill(), { consistent: true })]);
      return gate?.open === true && !signupKilled(kill);
    },

    /** One world request per account every ten minutes (a conditional stamp, real clock). */
    async worldRequest(sub: string): Promise<boolean> {
      const now = ctx.now();
      const earliest = new Date(now.getTime() - SIGNUP_LIMITS.worldRequestEverySeconds * 1_000).toISOString();
      try {
        await ctx.store.write({
          kind: "update",
          table: TABLE,
          key: signupRuntimeKeys.worldRequest(sub),
          condition: cond.or(cond.notExists("lastAtReal"), cond.lt("lastAtReal", earliest)),
          update: { set: { entity: "WorldRequestStamp", lastAtReal: now.toISOString(), expiresAt: expiresAt(now, LEADS_TTL_SECONDS.counter) } },
        });
        return true;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
        throw error;
      }
    },
  };
}

export type SignupCaps = ReturnType<typeof signupCaps>;
