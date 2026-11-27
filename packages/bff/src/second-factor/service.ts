// The SMS code of every console account (docs/architecture-guests.md §17): the enrolment of its mobile
// the first time, and the second factor of every sign-in session after it. The caller is the verified
// principal (its `sub`, world and sign-in session), never the input.
//
//   check       the session passed the code (or the account is automation) — routers/trpc.ts asks it
//               before every procedure but the account's own and these
//   status      what the verification screen shows: enrol (the number of the form, editable) or sign
//               in (only the last digits of the verified number), and when a new code may be asked for
//   sendCode    a 6-digit code (crypto random) by SMS, its HMAC stored for 10 minutes, after the resend
//               wait and the caps; a new number only while enrolling, never over a verified one
//   verify      5 attempts per code (counted before comparing, conditional), constant-time comparison;
//               the right code passes THIS session, and an enrolment also makes the number the
//               account's (one number, one account), queues a waiting self-signup world and sends its
//               lead notice — once, never on a sign-in
//   endSession  signing out ends the pass of the session
import { randomInt } from "node:crypto";
import { ConnectorError } from "@reclamo/shared";
import { AUDIT_ACTION, type AuditAction, type AuditSink } from "../auth/audit";
import type { RepoContext } from "../connector/codec";
import type { Connector } from "../connector/port";
import type { WriteOp } from "../connector/store";
import { smsCodeText } from "../copy/sms-code";
import type { SignupCaps } from "../guests/caps";
import { type ProvisionInvoker, provisionOps } from "../guests/provision";
import { safeEqual, ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { SECOND_FACTOR_LIMITS } from "../leads/limits";
import type { LeadsRepo } from "../leads/repo";
import { type SmsCapScope, takeSms } from "./caps";
import type { SecondFactorHashes } from "./hashes";
import { lastDigits, normalizePhone } from "./phone-number";
import type { AccountPhone, PhoneCode } from "./records";
import { type SecondFactorRepo, secondFactorRepo } from "./repo";
import { type SmsSender, SmsUndeliverable } from "./sms";

/** Who asks, from the verified principal and its world. */
export interface SecondFactorCaller {
  readonly sub: string;
  readonly worldId: string;
  readonly staffId: string;
  /** `origin_jti` of the id token, or `auth_time:<n>` when it has none. */
  readonly signInKey: string;
  /** Epoch seconds of the interactive sign-in: the session can live `sessionHours` from it. */
  readonly authTime: number;
  /** A marked automation account of a QA world, or the QaDriver's in-process principal. */
  readonly automation: boolean;
  /** A self-signup (`gs-*`): its lead takes the verified number and is notified at enrolment. */
  readonly selfSignup: boolean;
  readonly epoch: number;
}

export type SecondFactorCheck = "PASSED" | "EXEMPT" | "REQUIRED";

export type SecondFactorStatus =
  | { readonly state: "PASSED" | "EXEMPT" }
  | { readonly state: "ENROL"; readonly phone?: string; readonly codeSent: boolean; readonly resendAvailableAtReal?: string }
  | { readonly state: "SIGN_IN"; readonly lastDigits: string; readonly codeSent: boolean; readonly resendAvailableAtReal?: string };

export type SendCodeResult =
  | { readonly status: "CODE_SENT"; readonly purpose: PhoneCode["purpose"]; readonly lastDigits: string; readonly resendAvailableAtReal: string }
  | { readonly status: "RESEND_TOO_SOON"; readonly resendAvailableAtReal: string }
  | { readonly status: "RATE_LIMITED"; readonly limit: SmsCapScope }
  | { readonly status: "INVALID_PHONE" | "PHONE_IN_USE" | "PHONE_LOCKED" | "SMS_FAILED" | "NOT_REQUIRED" };

export type VerifyCodeResult =
  | { readonly status: "VERIFIED" | "NOT_REQUIRED" | "NO_CODE" | "CODE_EXPIRED" | "PHONE_IN_USE" }
  | { readonly status: "CODE_MISMATCH"; readonly attemptsLeft: number };

/** Passed sessions one container already read, kept no longer than `passCacheSeconds` (or the session). */
export class PassCache {
  private readonly passed = new Map<string, number>();
  has(key: string, nowMs: number): boolean {
    const until = this.passed.get(key);
    if (until !== undefined && until > nowMs) return true;
    this.passed.delete(key);
    return false;
  }
  remember(key: string, untilMs: number): void {
    this.passed.set(key, untilMs);
  }
  forget(key: string): void {
    this.passed.delete(key);
  }
}

export interface SecondFactorDeps {
  readonly ctx: RepoContext;
  readonly worlds: Pick<Connector["worlds"], "getMeta">;
  readonly leads: Pick<LeadsRepo, "phoneVerifiedOp">;
  readonly caps: Pick<SignupCaps, "count" | "takeAll">;
  readonly hashes: SecondFactorHashes;
  readonly sms: SmsSender;
  readonly invoker: ProvisionInvoker;
  readonly audit: AuditSink;
  readonly cache: PassCache;
  readonly log: Logger;
  /** Six digits; crypto random unless a test fixes it. */
  readonly newCode?: () => string;
}

const randomCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

const plusSeconds = (at: Date, seconds: number): string => new Date(at.getTime() + seconds * 1_000).toISOString();

export function secondFactorService(deps: SecondFactorDeps) {
  const repo: SecondFactorRepo = secondFactorRepo(deps.ctx);
  const sessionHashOf = (caller: SecondFactorCaller) => deps.hashes.sessionHash(caller.sub, caller.signInKey);
  const cacheKey = (caller: SecondFactorCaller) => `${caller.sub}|${sessionHashOf(caller)}`;
  /** The pass lives as long as the console session can: `sessionHours` from the interactive sign-in. */
  const sessionEnd = (caller: SecondFactorCaller) => new Date((caller.authTime + SECOND_FACTOR_LIMITS.sessionHours * 3_600) * 1_000).toISOString();

  const passed = async (caller: SecondFactorCaller): Promise<boolean> => {
    const now = deps.ctx.now().getTime();
    if (deps.cache.has(cacheKey(caller), now)) return true;
    const session = await repo.session(caller.sub, sessionHashOf(caller));
    if (!session || session.endedAtReal !== undefined || Date.parse(session.validUntilReal) <= now) return false;
    deps.cache.remember(cacheKey(caller), Math.min(Date.parse(session.validUntilReal), now + SECOND_FACTOR_LIMITS.passCacheSeconds * 1_000));
    return true;
  };

  const audit = async (caller: SecondFactorCaller, action: AuditAction, outcome: string): Promise<void> => {
    try {
      await deps.audit.record({ worldId: caller.worldId, epoch: caller.epoch, action, outcome, actor: `OPERATOR:${caller.staffId}`, refs: { staffId: caller.staffId } });
    } catch (error) {
      deps.log.error("second_factor.audit_failed", { action, errorName: error instanceof Error ? error.name : "UnknownError" });
    }
  };

  /** The open code of THIS session, still inside its life. */
  const liveCode = (code: PhoneCode | undefined, caller: SecondFactorCaller): code is PhoneCode =>
    code !== undefined && code.state === "OPEN" && code.sessionHash === sessionHashOf(caller) && Date.parse(code.validUntilReal) > deps.ctx.now().getTime();

  const resendAt = (code: PhoneCode | undefined): string | undefined => {
    if (!code) return undefined;
    const at = plusSeconds(new Date(code.sentAtReal), SECOND_FACTOR_LIMITS.resendWaitSeconds);
    return Date.parse(at) > deps.ctx.now().getTime() ? at : undefined;
  };

  // Where a code goes: the verified number (never another), or the number being enrolled.
  const target = (account: AccountPhone | undefined, typed: string | undefined): { phone: string; purpose: PhoneCode["purpose"] } | SendCodeResult => {
    if (account?.status === "VERIFIED" && account.phone) return typed === undefined ? { phone: account.phone, purpose: "SIGN_IN" } : { status: "PHONE_LOCKED" };
    const phone = normalizePhone(typed ?? account?.phone ?? "");
    return phone ? { phone, purpose: "ENROL" } : { status: "INVALID_PHONE" };
  };

  // Everything an enrolment changes, in one transaction; `queued` when a waiting world goes to the queue.
  const enrolOps = async (caller: SecondFactorCaller, code: PhoneCode, at: Date): Promise<{ ops: WriteOp[]; requestId?: string }> => {
    const ops: WriteOp[] = [
      repo.ownerOp(code.phoneHash, caller.sub),
      repo.verifiedPhoneOp({ sub: caller.sub, status: "VERIFIED", phone: code.phone, phoneHash: code.phoneHash, verifiedAtReal: at.toISOString(), ...(await localeOf(caller)) }),
    ];
    if (!caller.selfSignup) return { ops };
    ops.push(deps.leads.phoneVerifiedOp(caller.sub, code.phone, at));
    const meta = await deps.worlds.getMeta(caller.worldId, { consistent: true });
    if (meta?.status !== "PHONE_PENDING") return { ops };
    const requestId = ulid(at.getTime());
    ops.push(...provisionOps(deps.ctx).phoneVerifiedOps(caller.worldId, requestId));
    return { ops, requestId };
  };

  const localeOf = async (caller: SecondFactorCaller): Promise<{ locale?: "es" | "en" }> => {
    const locale = (await repo.accountPhone(caller.sub))?.locale;
    return locale ? { locale } : {};
  };

  const afterEnrolment = async (caller: SecondFactorCaller, requestId: string | undefined): Promise<void> => {
    const calls: Promise<void>[] = [];
    if (requestId) calls.push(deps.invoker.createWorld({ kind: "WORLD_CREATE", worldId: caller.worldId, requestId }));
    if (caller.selfSignup) calls.push(deps.invoker.notifyLead({ leadId: caller.sub }));
    for (const result of await Promise.allSettled(calls)) {
      if (result.status === "rejected") deps.log.warn("second_factor.invoke_failed", { errorName: result.reason instanceof Error ? result.reason.name : "UnknownError" });
    }
  };

  return {
    async check(caller: SecondFactorCaller): Promise<SecondFactorCheck> {
      if (caller.automation) return "EXEMPT";
      return (await passed(caller)) ? "PASSED" : "REQUIRED";
    },

    async status(caller: SecondFactorCaller): Promise<SecondFactorStatus> {
      if (caller.automation) return { state: "EXEMPT" };
      if (await passed(caller)) return { state: "PASSED" };
      const [account, code] = await Promise.all([repo.accountPhone(caller.sub), repo.code(caller.sub)]);
      const resend = resendAt(code);
      const waiting = { codeSent: liveCode(code, caller), ...(resend ? { resendAvailableAtReal: resend } : {}) };
      if (account?.status === "VERIFIED" && account.phone) return { state: "SIGN_IN", lastDigits: lastDigits(account.phone), ...waiting };
      return { state: "ENROL", ...(account?.phone ? { phone: account.phone } : {}), ...waiting };
    },

    async sendCode(caller: SecondFactorCaller, input: { readonly phone?: string | undefined; readonly locale?: "es" | "en" | undefined }, viewerIp: string): Promise<SendCodeResult> {
      if (caller.automation) return { status: "NOT_REQUIRED" };
      const account = await repo.accountPhone(caller.sub);
      const where = target(account, input.phone);
      if ("status" in where) return where;
      if (await passed(caller)) return { status: "NOT_REQUIRED" };
      const phoneHash = deps.hashes.phoneHash(where.phone);
      if (where.purpose === "ENROL") {
        const owner = await repo.owner(phoneHash);
        if (owner && owner.sub !== caller.sub) return { status: "PHONE_IN_USE" };
      }
      const wait = resendAt(await repo.code(caller.sub));
      if (wait) return { status: "RESEND_TOO_SOON", resendAvailableAtReal: wait };

      const now = deps.ctx.now();
      const full = await takeSms(deps.caps, { sub: caller.sub, ipHash: deps.hashes.ipHash(viewerIp), ...(where.purpose === "ENROL" ? { enrolPhoneHash: phoneHash } : {}) }, now);
      if (full) {
        await audit(caller, AUDIT_ACTION.SECOND_FACTOR_REFUSED, `SMS_CAP_${full}`);
        return { status: "RATE_LIMITED", limit: full };
      }
      const code = (deps.newCode ?? randomCode)();
      const sessionHash = sessionHashOf(caller);
      const sentAtReal = now.toISOString();
      const record: PhoneCode = {
        sub: caller.sub,
        purpose: where.purpose,
        sessionHash,
        phone: where.phone,
        phoneHash,
        codeHash: deps.hashes.codeHash({ sub: caller.sub, sessionHash, sentAtReal, code }),
        attempts: 0,
        state: "OPEN",
        sentAtReal,
        validUntilReal: plusSeconds(now, SECOND_FACTOR_LIMITS.codeValidSeconds),
      };
      const resendAvailableAtReal = plusSeconds(now, SECOND_FACTOR_LIMITS.resendWaitSeconds);
      if (!(await repo.putCode(record))) return { status: "RESEND_TOO_SOON", resendAvailableAtReal };
      try {
        await deps.sms.send({ phone: where.phone, text: smsCodeText(account?.locale ?? input.locale ?? "es", code) });
      } catch (error) {
        deps.log.warn("second_factor.sms_failed", { errorName: error instanceof Error ? error.name : "UnknownError", undeliverable: error instanceof SmsUndeliverable });
        await repo.burn(record);
        return { status: "SMS_FAILED" };
      }
      return { status: "CODE_SENT", purpose: where.purpose, lastDigits: lastDigits(where.phone), resendAvailableAtReal };
    },

    async verify(caller: SecondFactorCaller, input: { readonly code: string }): Promise<VerifyCodeResult> {
      if (caller.automation) return { status: "NOT_REQUIRED" };
      if (await passed(caller)) return { status: "VERIFIED" };
      const code = await repo.code(caller.sub);
      if (!code || code.state !== "OPEN" || code.sessionHash !== sessionHashOf(caller)) return { status: "NO_CODE" };
      const now = deps.ctx.now();
      if (Date.parse(code.validUntilReal) <= now.getTime()) return { status: "CODE_EXPIRED" };
      if (!(await repo.countAttempt(code))) return { status: "CODE_EXPIRED" };
      const used = code.attempts + 1;
      const expected = deps.hashes.codeHash({ sub: caller.sub, sessionHash: code.sessionHash, sentAtReal: code.sentAtReal, code: input.code });
      if (!safeEqual(expected, code.codeHash)) {
        const attemptsLeft = Math.max(0, SECOND_FACTOR_LIMITS.attemptsPerCode - used);
        if (attemptsLeft === 0) {
          await repo.burn({ ...code, attempts: used });
          await audit(caller, AUDIT_ACTION.SECOND_FACTOR_REFUSED, "CODE_BURNT");
        }
        return { status: "CODE_MISMATCH", attemptsLeft };
      }

      const pass = repo.passedOp(caller.sub, code.sessionHash, sessionEnd(caller));
      if (code.purpose === "SIGN_IN") {
        try {
          await deps.ctx.store.transact([repo.usedOp(code), repo.stillVerifiedOp(caller.sub, code.phoneHash), pass]);
        } catch (error) {
          if (error instanceof ConnectorError && error.code === "CONFLICT") return { status: "NO_CODE" };
          throw error;
        }
        await audit(caller, AUDIT_ACTION.SECOND_FACTOR_PASSED, "SIGN_IN");
        return { status: "VERIFIED" };
      }

      const enrolment = await enrolOps(caller, code, now);
      try {
        await deps.ctx.store.transact([repo.usedOp(code), ...enrolment.ops, pass]);
      } catch (error) {
        if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
        const owner = await repo.owner(code.phoneHash);
        return { status: owner && owner.sub !== caller.sub ? "PHONE_IN_USE" : "NO_CODE" };
      }
      await audit(caller, AUDIT_ACTION.PHONE_ENROLLED, caller.selfSignup ? "SELF_SIGNUP" : "ACCOUNT");
      await afterEnrolment(caller, enrolment.requestId);
      return { status: "VERIFIED" };
    },

    async endSession(caller: SecondFactorCaller): Promise<{ readonly status: "ENDED" }> {
      deps.cache.forget(cacheKey(caller));
      if (!caller.automation) await repo.endSession(caller.sub, sessionHashOf(caller));
      return { status: "ENDED" };
    },
  };
}

export type SecondFactorService = ReturnType<typeof secondFactorService>;
