// Reads and writes of the SMS code (docs/architecture-guests.md §17) over the connector's storage port,
// so DynamoDB and the memory engine run the same conditions. The Bff reaches `PHONEVER#`, `PHONEOWNER#`
// and `PHONECODE#` of `Leads` and `SECONDFACTOR#` of `Runtime` (infra/iam-leading-keys.ts); nothing here
// reads a lead.
import { ConnectorError } from "@reclamo/shared";
import { type RepoContext, decodeOptional, encode } from "../connector/codec";
import { type Condition, type WriteOp, cond } from "../connector/store";
import { leadsKeys, secondFactorRuntimeKeys } from "../leads/keys";
import { LEADS_TTL_SECONDS, SECOND_FACTOR_LIMITS, expiresAt } from "../leads/limits";
import { AccountPhone, PassedSession, PhoneCode, PhoneOwner } from "./records";

const LEADS = "Leads" as const;
const RUNTIME = "Runtime" as const;

const isConflict = (error: unknown): boolean => error instanceof ConnectorError && error.code === "CONFLICT";

/** Writes a conditional op and reports whether its condition held. */
async function tried(ctx: RepoContext, op: WriteOp): Promise<boolean> {
  try {
    await ctx.store.write(op);
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

/** The code still belongs to the send it was read from (`sentAtReal`) and is open. */
const sameOpenCode = (code: Pick<PhoneCode, "sentAtReal">): Condition => cond.and(cond.present(), cond.eq("state", "OPEN"), cond.eq("sentAtReal", code.sentAtReal));

export function secondFactorRepo(ctx: RepoContext) {
  return {
    async accountPhone(sub: string): Promise<AccountPhone | undefined> {
      return decodeOptional(AccountPhone, await ctx.store.get(LEADS, leadsKeys.accountPhone(sub), { consistent: true }), LEADS);
    },

    async owner(phoneHash: string): Promise<{ readonly sub: string } | undefined> {
      return decodeOptional(PhoneOwner, await ctx.store.get(LEADS, leadsKeys.phoneOwner(phoneHash), { consistent: true }), LEADS);
    },

    async code(sub: string): Promise<PhoneCode | undefined> {
      return decodeOptional(PhoneCode, await ctx.store.get(LEADS, leadsKeys.phoneCode(sub), { consistent: true }), LEADS);
    },

    async session(sub: string, sessionHash: string): Promise<PassedSession | undefined> {
      return decodeOptional(PassedSession, await ctx.store.get(RUNTIME, secondFactorRuntimeKeys.session(sub, sessionHash), { consistent: true }), RUNTIME);
    },

    /** A self-signup's pending phone (the number of its form), written with its registration. */
    pendingPhoneOp(phone: Omit<AccountPhone, "status" | "verifiedAtReal" | "phoneHash">): WriteOp {
      const now = ctx.now();
      const item = encode({ ...phone, status: "PENDING" }, { entity: "AccountPhone", key: leadsKeys.accountPhone(phone.sub), now });
      return { kind: "put", table: LEADS, item: { ...item, expiresAt: expiresAt(now, LEADS_TTL_SECONDS.lead) }, condition: cond.absent() };
    },

    /**
     * A new code replaces the last one only after the resend wait (`sentAtReal` at least that old), so two
     * racing sends never both reach a phone.
     */
    async putCode(code: PhoneCode): Promise<boolean> {
      const now = ctx.now();
      const earliest = new Date(now.getTime() - SECOND_FACTOR_LIMITS.resendWaitSeconds * 1_000).toISOString();
      const item = encode(code, { entity: "PhoneCode", key: leadsKeys.phoneCode(code.sub), now });
      return tried(ctx, {
        kind: "put",
        table: LEADS,
        item: { ...item, expiresAt: Math.floor(Date.parse(code.validUntilReal) / 1_000) },
        condition: cond.or(cond.absent(), cond.le("sentAtReal", earliest)),
      });
    },

    /** One attempt, counted before the comparison and only while fewer than the cap were made. */
    countAttempt(code: PhoneCode): Promise<boolean> {
      return tried(ctx, {
        kind: "update",
        table: LEADS,
        key: leadsKeys.phoneCode(code.sub),
        condition: cond.and(sameOpenCode(code), cond.lt("attempts", SECOND_FACTOR_LIMITS.attemptsPerCode)),
        update: { add: { attempts: 1 }, set: { updatedAt: ctx.now().toISOString() } },
      });
    },

    /** The last failed attempt burns the code: a new one has to be asked for. */
    async burn(code: PhoneCode): Promise<void> {
      await tried(ctx, { kind: "update", table: LEADS, key: leadsKeys.phoneCode(code.sub), condition: sameOpenCode(code), update: { set: { state: "BURNT", updatedAt: ctx.now().toISOString() } } });
    },

    usedOp(code: PhoneCode): WriteOp {
      return { kind: "update", table: LEADS, key: leadsKeys.phoneCode(code.sub), condition: sameOpenCode(code), update: { set: { state: "USED", updatedAt: ctx.now().toISOString() } } };
    },

    /** The number becomes the account's: never over a verified one (the person cannot change it). */
    verifiedPhoneOp(phone: AccountPhone & { readonly status: "VERIFIED" }): WriteOp {
      const now = ctx.now();
      const item = encode(phone, { entity: "AccountPhone", key: leadsKeys.accountPhone(phone.sub), now });
      return { kind: "put", table: LEADS, item: { ...item, expiresAt: expiresAt(now, LEADS_TTL_SECONDS.lead) }, condition: cond.or(cond.absent(), cond.eq("status", "PENDING")) };
    },

    /** One number, one account: the owner is written once (or again by the same account). */
    ownerOp(phoneHash: string, sub: string): WriteOp {
      const now = ctx.now();
      const item = encode({ sub, atReal: now.toISOString() }, { entity: "PhoneOwner", key: leadsKeys.phoneOwner(phoneHash), now });
      return { kind: "put", table: LEADS, item: { ...item, expiresAt: expiresAt(now, LEADS_TTL_SECONDS.lead) }, condition: cond.or(cond.absent(), cond.eq("sub", sub)) };
    },

    /** The account's phone is still the verified one the code was sent to. */
    stillVerifiedOp(sub: string, phoneHash: string): WriteOp {
      return { kind: "check", table: LEADS, key: leadsKeys.accountPhone(sub), condition: cond.and(cond.present(), cond.eq("status", "VERIFIED"), cond.eq("phoneHash", phoneHash)) };
    },

    passedOp(sub: string, sessionHash: string, validUntilReal: string): WriteOp {
      const now = ctx.now();
      const item = encode({ sub, passedAtReal: now.toISOString(), validUntilReal }, { entity: "PassedSession", key: secondFactorRuntimeKeys.session(sub, sessionHash), now });
      return { kind: "put", table: RUNTIME, item: { ...item, expiresAt: Math.floor(Date.parse(validUntilReal) / 1_000) } };
    },

    /** Signing out ends the pass of that session (a later token of it asks for a code again). */
    async endSession(sub: string, sessionHash: string): Promise<void> {
      const now = ctx.now().toISOString();
      await tried(ctx, { kind: "update", table: RUNTIME, key: secondFactorRuntimeKeys.session(sub, sessionHash), condition: cond.present(), update: { set: { endedAtReal: now, updatedAt: now } } });
    },
  };
}

export type SecondFactorRepo = ReturnType<typeof secondFactorRepo>;
