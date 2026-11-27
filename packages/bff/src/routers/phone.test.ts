// The SMS code in front of every console procedure (docs/architecture-guests.md §17, FL-129, FL-130):
// with the real `worldProcedure`, the real service over the memory engine and the memory SMS outbox. A
// right password without the code reaches nothing but `account.session` and `phone.*`; the code passes
// only its own sign-in session; a refresh (same `origin_jti`) keeps it; signing out ends it; only an
// automation account of a QA world, marked on its staff row by the server, is exempt.
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { createTestDeps, staffRow } from "../auth/testing";
import { createMemoryConnector } from "../connector/memory/connector";
import { memorySmsSender, testSecondFactor } from "../second-factor/doubles";
import { createCaller } from "./index";
import { createContextFactory } from "./trpc";

const SUB = "3b7c1d2e-0000-4000-8000-00000000d001";

function setup() {
  const { issuer, directory, deps, audit } = createTestDeps();
  const { connector, store } = createMemoryConnector({ now: () => new Date() });
  const sms = memorySmsSender();
  const secondFactor = testSecondFactor({ ctx: { store, now: () => new Date() }, worlds: connector.worlds, audit, sms });
  directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", SUB));
  directory.putStaff(staffRow("demo", "stf-compliance-01", "COMPLIANCE", "sub-compliance-01"));
  directory.putStaff(staffRow("demo", "stf-marked", "OPERATOR", "sub-marked", { automation: true }));
  directory.putStaff(staffRow("qa-r1-sc01", "stf-qa-operator", "OPERATOR", "sub-qa", { automation: true }));
  directory.setWorld("demo", "READY");
  directory.setWorld("qa-r1-sc01", "READY");
  const contextFor = createContextFactory(() => ({ ...deps, secondFactor }));
  const callerFor = async (claims: Record<string, unknown> = {}) => {
    const token = issuer.idToken({ sub: SUB, "cognito:username": "operator-01", "cognito:groups": ["OPERATOR"], worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", ...claims });
    return createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}`, "x-reclamo-viewer-ip": "203.0.113.7" } } }));
  };
  return { callerFor, sms };
}

async function reasonOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    const reason: unknown = error.cause && typeof error.cause === "object" ? Reflect.get(error.cause, "reason") : undefined;
    return typeof reason === "string" ? reason : error.code;
  }
}

describe("the SMS code in front of the console [FL-129] [FL-130]", () => {
  it("[FL-130] a right password without the code reaches nothing but account.session and phone.*", async () => {
    const { callerFor } = setup();
    const caller = await callerFor();
    expect(await reasonOf(() => caller.inbox.list({}))).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await reasonOf(() => caller.clock.get())).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await reasonOf(() => caller.guest.status())).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await reasonOf(() => caller.account.session())).not.toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await caller.phone.status()).toEqual({ state: "ENROL", codeSent: false });
  });

  it("[FL-129] [FL-130] the enrolment passes this session; a refresh keeps it; another sign-in asks for its own code; signing out ends it", async () => {
    const { callerFor, sms } = setup();
    const session = { origin_jti: "0d1c2b3a-0000-4000-8000-00000000b001" };
    const caller = await callerFor(session);
    expect(await caller.phone.sendCode({ phone: "+54 9 11 5555-0100" })).toMatchObject({ status: "CODE_SENT", purpose: "ENROL" });
    expect(await caller.phone.verify({ code: sms.lastCode() ?? "" })).toEqual({ status: "VERIFIED" });
    // Every HTTP request is a context of its own (the check is memoized per request).
    const next = await callerFor(session);
    expect(await reasonOf(() => next.inbox.list({}))).not.toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);

    const refreshed = await callerFor({ ...session, iat: Math.floor(Date.now() / 1_000) });
    expect(await reasonOf(() => refreshed.inbox.list({}))).not.toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);

    const other = await callerFor({ origin_jti: "0d1c2b3a-0000-4000-8000-00000000b002" });
    expect(await reasonOf(() => other.inbox.list({}))).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await other.phone.status()).toMatchObject({ state: "SIGN_IN", lastDigits: "0100" });
    expect(await other.phone.sendCode({ phone: "+5493515550199" })).toEqual({ status: "PHONE_LOCKED" });

    expect(await next.phone.endSession()).toEqual({ status: "ENDED" });
    const again = await callerFor(session);
    expect(await reasonOf(() => again.inbox.list({}))).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
  });

  it("[FL-130] COMPLIANCE passes its own code, and stays read-only for the world", async () => {
    const { callerFor, sms } = setup();
    const claims = { sub: "sub-compliance-01", "cognito:username": "compliance-01", "cognito:groups": ["COMPLIANCE"], staffId: "stf-compliance-01", role: "COMPLIANCE" };
    const compliance = await callerFor(claims);
    expect(await compliance.phone.sendCode({ phone: "+5491155550111" })).toMatchObject({ status: "CODE_SENT" });
    expect(await compliance.phone.verify({ code: sms.lastCode() ?? "" })).toEqual({ status: "VERIFIED" });
    const after = await callerFor(claims);
    expect(await reasonOf(() => after.inbox.list({}))).not.toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await reasonOf(() => after.complaints.note({ complaintId: "cmp-x", text: "nota" } as never))).toBe(AUTH_REASON.READ_ONLY_ROLE);
  });

  it("[FL-130] exempts only a server-marked automation account of a QA world; the same mark elsewhere counts nothing", async () => {
    const { callerFor, sms } = setup();
    const bot = await callerFor({ sub: "sub-qa", "cognito:username": "qa-r1-sc01-operator", worldId: "qa-r1-sc01", staffId: "stf-qa-operator" });
    expect(await reasonOf(() => bot.clock.get())).not.toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await bot.phone.status()).toEqual({ state: "EXEMPT" });
    const marked = await callerFor({ sub: "sub-marked", "cognito:username": "operator-02", staffId: "stf-marked" });
    expect(await reasonOf(() => marked.inbox.list({}))).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(sms.outbox).toEqual([]);
  });

  it("fails closed without the service: every session but automation is held", async () => {
    const { issuer, directory, deps } = createTestDeps();
    directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", SUB));
    directory.setWorld("demo", "READY");
    const { secondFactor: _passed, ...withoutIt } = deps;
    const token = issuer.idToken({ sub: SUB, "cognito:username": "operator-01", "cognito:groups": ["OPERATOR"], worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR" });
    const caller = createCaller(await createContextFactory(() => withoutIt)({ event: { headers: { authorization: `Bearer ${token}` } } }));
    expect(await reasonOf(() => caller.inbox.list({}))).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
  });
});
