// The SMS code (docs/architecture-guests.md §17, FL-129, FL-130, FL-131): enrolment of the mobile, the
// second factor of every sign-in session, the code's rules and every cap, over the memory engine with
// the memory SMS outbox (nothing reaches a phone) and a real clock the test moves.
import { describe, expect, it } from "vitest";
import { createMemoryAudit } from "../auth/testing";
import { createMemoryConnector } from "../connector/memory/connector";
import { SMS_CODE_MINUTES } from "../copy/sms-code";
import { leadsKeys, secondFactorRuntimeKeys } from "../leads/keys";
import { SECOND_FACTOR_LIMITS } from "../leads/limits";
import { createLogger } from "../lib/log";
import { memorySmsSender, testSecondFactor } from "./doubles";
import { secondFactorRepo } from "./repo";
import type { SecondFactorCaller } from "./service";

const PHONE = "+5491155550100";
const OTHER_PHONE = "+5493515550199";
const IP = "203.0.113.7";

function rig(options: { readonly codes?: readonly string[] } = {}) {
  let clock = new Date("2026-11-27T13:00:00.000Z");
  const now = () => new Date(clock.getTime());
  const { connector, store } = createMemoryConnector({ now });
  const ctx = { store, now };
  const sms = memorySmsSender();
  const audit = createMemoryAudit();
  const invoked = { worlds: [] as unknown[], notices: [] as unknown[] };
  const codes = [...(options.codes ?? [])];
  const service = testSecondFactor({
    ctx,
    worlds: connector.worlds,
    audit,
    sms,
    invoker: { createWorld: async (request) => void invoked.worlds.push(request), notifyLead: async (request) => void invoked.notices.push(request) },
    ...(options.codes ? { newCode: () => codes.shift() ?? "000000" } : {}),
  })(createLogger({ sink: () => undefined }));
  const caller = (sub = "sub-operator-01", extra: Partial<SecondFactorCaller> = {}): SecondFactorCaller => ({
    sub,
    worldId: "demo",
    staffId: `stf-${sub}`,
    signInKey: "jti-session-a",
    authTime: Math.floor(now().getTime() / 1_000),
    automation: false,
    selfSignup: false,
    epoch: 1,
    ...extra,
  });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { store, ctx, sms, audit, invoked, service, caller, advance, now };
}

/** Enrols `phone` for a caller with the code the outbox received. */
async function enrol(r: ReturnType<typeof rig>, who: SecondFactorCaller, phone = PHONE) {
  const sent = await r.service.sendCode(who, { phone }, IP);
  expect(sent.status).toBe("CODE_SENT");
  return r.service.verify(who, { code: r.sms.lastCode(phone) ?? "" });
}

describe("enrolment of the account's mobile [FL-129]", () => {
  it("[FL-129] a pending self-signup gets the number of its form prefilled, the code by SMS, and on the right code its session passes", async () => {
    const r = rig({ codes: ["482913"] });
    const who = r.caller("sub-ana", { worldId: "gs-abcdefgh23", selfSignup: false });
    await r.store.write(secondFactorRepo(r.ctx).pendingPhoneOp({ sub: "sub-ana", phone: PHONE, locale: "en" }));
    expect(await r.service.check(who)).toBe("REQUIRED");
    expect(await r.service.status(who)).toEqual({ state: "ENROL", phone: PHONE, codeSent: false });
    expect(await r.service.sendCode(who, {}, IP)).toMatchObject({ status: "CODE_SENT", purpose: "ENROL", lastDigits: "0100" });
    expect(r.sms.outbox).toEqual([{ phone: PHONE, text: "Your Reclamo en regla code is 482913. It expires in 10 minutes." }]);
    const stored = await r.store.get("Leads", leadsKeys.phoneCode("sub-ana"));
    expect(JSON.stringify(stored)).not.toContain("482913");
    expect(stored?.expiresAt).toBe(Math.floor(r.now().getTime() / 1_000) + SECOND_FACTOR_LIMITS.codeValidSeconds);
    expect(await r.service.status(who)).toMatchObject({ state: "ENROL", codeSent: true });
    expect(await r.service.verify(who, { code: "111111" })).toEqual({ status: "CODE_MISMATCH", attemptsLeft: 4 });
    expect(await r.service.verify(who, { code: "482913" })).toEqual({ status: "VERIFIED" });
    expect(await r.service.check(who)).toBe("PASSED");
    expect(await r.store.get("Leads", leadsKeys.accountPhone("sub-ana"))).toMatchObject({ status: "VERIFIED", phone: PHONE, verifiedAtReal: r.now().toISOString() });
    expect(r.audit.entries.map((entry) => entry.action)).toEqual(["PHONE_ENROLLED"]);
    expect(JSON.stringify(r.audit.entries)).not.toContain(PHONE);
  });

  it("[FL-129] an existing account without a number (staff, an invited guest) types one; a malformed one is refused", async () => {
    const r = rig();
    const who = r.caller();
    expect(await r.service.status(who)).toEqual({ state: "ENROL", codeSent: false });
    expect(await r.service.sendCode(who, {}, IP)).toEqual({ status: "INVALID_PHONE" });
    expect(await r.service.sendCode(who, { phone: "11 5555 0100" }, IP)).toEqual({ status: "INVALID_PHONE" });
    expect(await r.service.sendCode(who, { phone: "+0 11 5555" }, IP)).toEqual({ status: "INVALID_PHONE" });
    expect(await r.service.sendCode(who, { phone: "+54 9 (11) 5555-0100" }, IP)).toMatchObject({ status: "CODE_SENT" });
    expect(r.sms.outbox[0]?.phone).toBe(PHONE);
    expect(r.sms.outbox[0]?.text).toMatch(/^Tu código de Reclamo en regla es \d{6}\. Vence en 10 minutos\.$/);
    expect(SMS_CODE_MINUTES * 60).toBe(SECOND_FACTOR_LIMITS.codeValidSeconds);
  });

  it("[FL-129] notifies the lead and queues its waiting world only at the enrolment of a self-signup, never at a sign-in", async () => {
    const r = rig();
    const worldId = "gs-abcdefgh23";
    await r.store.write({ kind: "put", table: "Worlds", item: { pk: `W#${worldId}#WORLD`, sk: "META", worldId, kind: "GUEST", template: "guest", epoch: 1, status: "PHONE_PENDING", origin: "SIGNUP", version: 1, createdAt: r.now().toISOString(), updatedAt: r.now().toISOString() } });
    await r.store.write({ kind: "put", table: "Leads", item: { ...leadsKeys.lead("sub-ana"), phoneStatus: "PENDING" } });
    const who = r.caller("sub-ana", { worldId, selfSignup: true });
    expect(await enrol(r, who)).toEqual({ status: "VERIFIED" });
    expect(r.invoked.worlds).toEqual([expect.objectContaining({ kind: "WORLD_CREATE", worldId })]);
    expect(r.invoked.notices).toEqual([{ leadId: "sub-ana" }]);
    expect(await r.store.get("Leads", leadsKeys.lead("sub-ana"))).toMatchObject({ phoneStatus: "VERIFIED", phone: PHONE });
    const second = r.caller("sub-ana", { worldId, selfSignup: true, signInKey: "jti-session-b" });
    r.advance(61_000);
    expect(await r.service.sendCode(second, {}, IP)).toMatchObject({ status: "CODE_SENT", purpose: "SIGN_IN" });
    expect(await r.service.verify(second, { code: r.sms.lastCode() ?? "" })).toEqual({ status: "VERIFIED" });
    expect(r.invoked.notices).toHaveLength(1);
    expect(r.invoked.worlds).toHaveLength(1);
  });

  it("[FL-131] one number, one account: a number another account verified is refused, before any SMS", async () => {
    const r = rig();
    expect(await enrol(r, r.caller("sub-a"))).toEqual({ status: "VERIFIED" });
    const sent = r.sms.outbox.length;
    expect(await r.service.sendCode(r.caller("sub-b"), { phone: PHONE }, IP)).toEqual({ status: "PHONE_IN_USE" });
    expect(r.sms.outbox).toHaveLength(sent);
  });

  it("[FL-131] two accounts racing for one number: the second verification is refused", async () => {
    const r = rig();
    const a = r.caller("sub-a");
    const b = r.caller("sub-b");
    await r.service.sendCode(a, { phone: PHONE }, IP);
    const codeA = r.sms.lastCode() ?? "";
    await r.service.sendCode(b, { phone: PHONE }, "198.51.100.9");
    const codeB = r.sms.lastCode() ?? "";
    expect(await r.service.verify(a, { code: codeA })).toEqual({ status: "VERIFIED" });
    expect(await r.service.verify(b, { code: codeB })).toEqual({ status: "PHONE_IN_USE" });
    expect(await r.service.check(b)).toBe("REQUIRED");
  });
});

describe("the code [FL-131]", () => {
  it("[FL-131] expires after 10 minutes (the date is compared, whatever the TTL did)", async () => {
    const r = rig();
    const who = r.caller();
    await r.service.sendCode(who, { phone: PHONE }, IP);
    const code = r.sms.lastCode() ?? "";
    r.advance(SECOND_FACTOR_LIMITS.codeValidSeconds * 1_000);
    expect(await r.service.verify(who, { code })).toEqual({ status: "CODE_EXPIRED" });
    expect(await r.service.check(who)).toBe("REQUIRED");
  });

  it("[FL-131] the fifth wrong attempt burns it: the right code no longer works and a new one is needed", async () => {
    const r = rig();
    const who = r.caller();
    await r.service.sendCode(who, { phone: PHONE }, IP);
    const code = r.sms.lastCode() ?? "";
    const wrong = code === "000000" ? "000001" : "000000";
    const answers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) answers.push(await r.service.verify(who, { code: wrong }));
    expect(answers.map((answer) => ("attemptsLeft" in answer ? answer.attemptsLeft : answer.status))).toEqual([4, 3, 2, 1, 0]);
    expect(await r.service.verify(who, { code })).toEqual({ status: "NO_CODE" });
    expect((await r.store.get("Leads", leadsKeys.phoneCode("sub-operator-01")))?.state).toBe("BURNT");
    expect(r.audit.entries.map((entry) => entry.outcome)).toContain("CODE_BURNT");
  });

  it("[FL-131] a resend before 60 seconds is refused with the instant it opens, after it a new code replaces the old one", async () => {
    const r = rig();
    const who = r.caller();
    await r.service.sendCode(who, { phone: PHONE }, IP);
    const first = r.sms.lastCode() ?? "";
    r.advance(59_000);
    expect(await r.service.sendCode(who, { phone: PHONE }, IP)).toEqual({ status: "RESEND_TOO_SOON", resendAvailableAtReal: new Date(r.now().getTime() + 1_000).toISOString() });
    expect(r.sms.outbox).toHaveLength(1);
    r.advance(1_000);
    expect(await r.service.sendCode(who, { phone: PHONE }, IP)).toMatchObject({ status: "CODE_SENT" });
    const second = r.sms.lastCode() ?? "";
    if (first !== second) expect(await r.service.verify(who, { code: first })).toMatchObject({ status: "CODE_MISMATCH" });
    expect(await r.service.verify(who, { code: second })).toEqual({ status: "VERIFIED" });
  });

  it("[FL-131] generates six crypto-random digits by default", async () => {
    const r = rig();
    for (let index = 0; index < 5; index += 1) {
      await r.service.sendCode(r.caller(`sub-${index}`), { phone: `+54911555501${String(index).padStart(2, "0")}` }, `203.0.113.${index}`);
    }
    expect(r.sms.outbox.map((message) => /\d{6}/.test(message.text))).toEqual([true, true, true, true, true]);
  });

  it("[FL-131] an SMS the network refuses answers SMS_FAILED and leaves no usable code", async () => {
    const r = rig();
    const who = r.caller();
    r.sms.failNext();
    expect(await r.service.sendCode(who, { phone: "+12025550123" }, IP)).toEqual({ status: "SMS_FAILED" });
    expect(await r.service.verify(who, { code: "123456" })).toEqual({ status: "NO_CODE" });
  });
});

describe("the SMS caps of the real day [FL-131]", () => {
  const sendEvery = async (r: ReturnType<typeof rig>, who: SecondFactorCaller, phone: string | undefined, ip = IP) => {
    r.advance(61_000);
    return r.service.sendCode(who, phone === undefined ? {} : { phone }, ip);
  };

  it("[FL-131] 3 enrolment SMS per number a day", async () => {
    const r = rig();
    const who = r.caller();
    for (let index = 0; index < 3; index += 1) expect((await sendEvery(r, who, PHONE)).status).toBe("CODE_SENT");
    expect(await sendEvery(r, who, PHONE)).toEqual({ status: "RATE_LIMITED", limit: "NUMBER" });
    expect((await sendEvery(r, who, OTHER_PHONE)).status).toBe("CODE_SENT");
  });

  it("[FL-131] 6 SMS per account a day, enrolment and sign-ins together, and the next day opens again", async () => {
    const r = rig();
    const enrolled = r.caller();
    expect(await enrol(r, enrolled)).toEqual({ status: "VERIFIED" });
    for (let index = 0; index < 5; index += 1) {
      const session = r.caller("sub-operator-01", { signInKey: `jti-${index}` });
      expect((await sendEvery(r, session, undefined, `198.51.100.${index}`)).status).toBe("CODE_SENT");
    }
    const seventh = r.caller("sub-operator-01", { signInKey: "jti-7" });
    expect(await sendEvery(r, seventh, undefined, "198.51.100.77")).toEqual({ status: "RATE_LIMITED", limit: "ACCOUNT" });
    expect(r.audit.entries.map((entry) => entry.outcome)).toContain("SMS_CAP_ACCOUNT");
    r.advance(24 * 3_600_000);
    expect((await sendEvery(r, seventh, undefined)).status).toBe("CODE_SENT");
  });

  it("[FL-131] 5 SMS per viewer IP a day, across accounts", async () => {
    const r = rig();
    for (let index = 0; index < 5; index += 1) expect((await sendEvery(r, r.caller(`sub-${index}`), `+54911555502${index}0`)).status).toBe("CODE_SENT");
    expect(await sendEvery(r, r.caller("sub-9"), "+5491155550290")).toEqual({ status: "RATE_LIMITED", limit: "IP" });
    expect((await sendEvery(r, r.caller("sub-9"), "+5491155550290", "198.51.100.1")).status).toBe("CODE_SENT");
  });

  it("[FL-131] 40 SMS a day for the whole demo, and a refusal spends no other cap", async () => {
    const r = rig();
    await r.store.write({ kind: "put", table: "Runtime", item: { ...secondFactorRuntimeKeys.globalDay(r.now()), count: SECOND_FACTOR_LIMITS.smsGlobalPerDay } });
    expect(await sendEvery(r, r.caller(), PHONE)).toEqual({ status: "RATE_LIMITED", limit: "GLOBAL" });
    expect(r.sms.outbox).toEqual([]);
    expect(await r.store.get("Runtime", secondFactorRuntimeKeys.accountDay("sub-operator-01", r.now()))).toBeUndefined();
  });

  it("[FL-131] numbers abroad share 5 SMS a day across the demo; a home number never takes that quota; the sixth abroad is refused", async () => {
    const r = rig();
    const abroad = ["+12025550123", "+358401234567", "+31612345678", "+5352345678", "+18685551234", "+447912345678"];
    for (let index = 0; index < 5; index += 1) {
      expect((await sendEvery(r, r.caller(`sub-abroad-${index}`), abroad[index], `198.51.100.${index}`)).status).toBe("CODE_SENT");
    }
    expect(await r.store.get("Runtime", secondFactorRuntimeKeys.abroadDay(r.now()))).toMatchObject({ count: 5 });
    const sent = r.sms.outbox.length;
    expect(await sendEvery(r, r.caller("sub-abroad-5"), abroad[5], "198.51.100.50")).toEqual({ status: "RATE_LIMITED", limit: "ABROAD" });
    expect(r.sms.outbox).toHaveLength(sent);
    expect(r.audit.entries.map((entry) => entry.outcome)).toContain("SMS_CAP_ABROAD");
    expect(await r.store.get("Runtime", secondFactorRuntimeKeys.accountDay("sub-abroad-5", r.now()))).toBeUndefined();
    for (const [index, phone] of ["+5491155550100", "+34612345678", "+18095551234"].entries()) {
      expect((await sendEvery(r, r.caller(`sub-home-${index}`), phone, `198.51.100.6${index}`)).status).toBe("CODE_SENT");
    }
    expect(await r.store.get("Runtime", secondFactorRuntimeKeys.abroadDay(r.now()))).toMatchObject({ count: 5 });
    r.advance(24 * 3_600_000);
    expect((await sendEvery(r, r.caller("sub-abroad-5"), abroad[5], "198.51.100.50")).status).toBe("CODE_SENT");
  });

  it("[FL-131] a sign-in to a verified number abroad takes the quota too", async () => {
    const r = rig();
    expect(await enrol(r, r.caller("sub-us"), "+12025550123")).toEqual({ status: "VERIFIED" });
    expect(await r.store.get("Runtime", secondFactorRuntimeKeys.abroadDay(r.now()))).toMatchObject({ count: 1 });
    await r.store.write({ kind: "put", table: "Runtime", item: { ...secondFactorRuntimeKeys.abroadDay(r.now()), count: SECOND_FACTOR_LIMITS.smsAbroadPerDay } });
    expect(await sendEvery(r, r.caller("sub-us", { signInKey: "jti-b" }), undefined)).toEqual({ status: "RATE_LIMITED", limit: "ABROAD" });
  });

  it("[FL-131] a range that is not a person's mobile, or a filler, is refused when typed or prefilled, before any SMS or cap", async () => {
    const r = rig();
    const who = r.caller();
    for (const phone of ["+3197010203040", "+447012345678", "+882123456789", "+883123456789", "+870123456789", "+881123456789", "+888123456789", "+979123456789"]) {
      expect(await r.service.sendCode(who, { phone }, IP), phone).toEqual({ status: "PHONE_NOT_ACCEPTED" });
    }
    expect(await r.service.sendCode(who, { phone: "+5491100000000" }, IP)).toEqual({ status: "INVALID_PHONE" });
    await r.store.write(secondFactorRepo(r.ctx).pendingPhoneOp({ sub: "sub-m2m", phone: "+3197010203040", locale: "es" }));
    expect(await r.service.sendCode(r.caller("sub-m2m"), {}, IP)).toEqual({ status: "PHONE_NOT_ACCEPTED" });
    expect(r.sms.outbox).toEqual([]);
    expect(await r.store.get("Runtime", secondFactorRuntimeKeys.globalDay(r.now()))).toBeUndefined();
  });

  it("keeps every number of the caps in one place", () => {
    expect(SECOND_FACTOR_LIMITS).toMatchObject({ smsPerAccountPerDay: 6, smsPerNumberPerDay: 3, smsPerIpPerDay: 5, smsGlobalPerDay: 40, smsAbroadPerDay: 5, attemptsPerCode: 5, resendWaitSeconds: 60, codeValidSeconds: 600 });
  });
});

describe("the second factor of every sign-in session [FL-130]", () => {
  it("[FL-130] the right code passes only that session; another sign-in asks for its own; a refresh (same origin_jti) does not", async () => {
    const r = rig();
    const a = r.caller();
    expect(await enrol(r, a)).toEqual({ status: "VERIFIED" });
    expect(await r.service.check({ ...a, authTime: a.authTime })).toBe("PASSED");
    const b = r.caller("sub-operator-01", { signInKey: "jti-session-b" });
    expect(await r.service.check(b)).toBe("REQUIRED");
    expect(await r.service.status(b)).toEqual({ state: "SIGN_IN", lastDigits: "0100", codeSent: false, resendAvailableAtReal: expect.any(String) });
    r.advance(61_000);
    expect(await r.service.sendCode(b, {}, IP)).toMatchObject({ status: "CODE_SENT", purpose: "SIGN_IN", lastDigits: "0100" });
    expect(r.sms.outbox.at(-1)?.phone).toBe(PHONE);
    expect(await r.service.verify(b, { code: r.sms.lastCode() ?? "" })).toEqual({ status: "VERIFIED" });
    expect(await r.service.check(b)).toBe("PASSED");
    expect(await r.service.check(a)).toBe("PASSED");
  });

  it("[FL-130] a code of one session never passes another", async () => {
    const r = rig();
    const a = r.caller();
    await enrol(r, a);
    const b = r.caller("sub-operator-01", { signInKey: "jti-session-b" });
    const c = r.caller("sub-operator-01", { signInKey: "jti-session-c" });
    r.advance(61_000);
    await r.service.sendCode(b, {}, IP);
    expect(await r.service.verify(c, { code: r.sms.lastCode() ?? "" })).toEqual({ status: "NO_CODE" });
    expect(await r.service.check(c)).toBe("REQUIRED");
  });

  it("[FL-130] the verified number cannot be changed, with the session pending or passed", async () => {
    const r = rig();
    const a = r.caller();
    await enrol(r, a);
    expect(await r.service.sendCode(a, { phone: OTHER_PHONE }, IP)).toEqual({ status: "PHONE_LOCKED" });
    const b = r.caller("sub-operator-01", { signInKey: "jti-session-b" });
    r.advance(61_000);
    expect(await r.service.sendCode(b, { phone: OTHER_PHONE }, IP)).toEqual({ status: "PHONE_LOCKED" });
    expect(r.sms.outbox.every((message) => message.phone === PHONE)).toBe(true);
    expect(await r.store.get("Leads", leadsKeys.accountPhone("sub-operator-01"))).toMatchObject({ phone: PHONE });
  });

  it("[FL-130] signing out ends the pass of that session; the pass also ends with the session's life", async () => {
    const r = rig();
    const a = r.caller();
    await enrol(r, a);
    expect(await r.service.endSession(a)).toEqual({ status: "ENDED" });
    expect(await r.service.check(a)).toBe("REQUIRED");
    const b = r.caller("sub-operator-01", { signInKey: "jti-session-b" });
    r.advance(61_000);
    await r.service.sendCode(b, {}, IP);
    await r.service.verify(b, { code: r.sms.lastCode() ?? "" });
    r.advance(SECOND_FACTOR_LIMITS.sessionHours * 3_600_000);
    expect(await r.service.check(b)).toBe("REQUIRED");
  });

  it("[FL-130] an automation account is exempt: no status to show, no SMS, nothing stored", async () => {
    const r = rig();
    const bot = r.caller("sub-qa", { worldId: "qa-r1-sc01", automation: true });
    expect(await r.service.check(bot)).toBe("EXEMPT");
    expect(await r.service.status(bot)).toEqual({ state: "EXEMPT" });
    expect(await r.service.sendCode(bot, { phone: PHONE }, IP)).toEqual({ status: "NOT_REQUIRED" });
    expect(r.sms.outbox).toEqual([]);
  });
});
