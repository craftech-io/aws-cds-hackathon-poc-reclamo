// An account an operator blocked (docs/architecture-guests.md §18, FL-132): with the real
// `worldProcedure`, the real SMS-code service over the memory engine and the memory SMS outbox. A
// still-valid token whose session already passed the code reaches nothing, the SMS code included, and
// no SMS leaves; before an SMS or a code the block is re-read past the container's staff cache.
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { createTestDeps, staffRow } from "../auth/testing";
import { createMemoryConnector } from "../connector/memory/connector";
import { memorySmsSender, testSecondFactor } from "../second-factor/doubles";
import { createCaller } from "./index";
import { createContextFactory } from "./trpc";

const SUB = "3b7c1d2e-0000-4000-8000-00000000d0b1";
const SESSION = { origin_jti: "0d1c2b3a-0000-4000-8000-00000000b0b1" };

async function setup() {
  const { issuer, directory, deps, audit } = createTestDeps();
  const { connector, store } = createMemoryConnector({ now: () => new Date() });
  const sms = memorySmsSender();
  const secondFactor = testSecondFactor({ ctx: { store, now: () => new Date() }, worlds: connector.worlds, audit, sms });
  // The same row in both places: the directory is what authentication reads (cached a minute in a
  // container), the connector what the SMS code re-reads uncached.
  directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", SUB));
  await connector.worlds.putStaff({ worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", displayName: "Operator", cognitoSubKey: `SUB#${SUB}`, active: true });
  directory.setWorld("demo", "READY");
  const contextFor = createContextFactory(() => ({ ...deps, secondFactor }));
  const callerFor = async () => {
    const token = issuer.idToken({ sub: SUB, "cognito:username": "operator-01", "cognito:groups": ["OPERATOR"], worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", ...SESSION });
    return createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}`, "x-reclamo-viewer-ip": "203.0.113.7" } } }));
  };
  /** Enrols and passes the session, like a person who signed in before the block. */
  const passSession = async () => {
    const caller = await callerFor();
    expect(await caller.phone.sendCode({ phone: "+54 9 11 5555-0100" })).toMatchObject({ status: "CODE_SENT" });
    expect(await caller.phone.verify({ code: sms.lastCode() ?? "" })).toEqual({ status: "VERIFIED" });
    expect(await reasonOf(async () => (await callerFor()).inbox.list({}))).not.toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
  };
  const blockEverywhere = async () => {
    directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", SUB, { blocked: true }));
    await connector.worlds.setStaffBlocked("demo", "stf-operator-01", true);
  };
  return { callerFor, passSession, blockEverywhere, sms, audit, connector, directory };
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

describe("a blocked account [FL-132]", () => {
  it("[FL-132] with a valid token and a session that passed the code reaches nothing, the SMS code included, and gets no SMS", async () => {
    const r = await setup();
    await r.passSession();
    const sent = r.sms.outbox.length;
    await r.blockEverywhere();
    const caller = await r.callerFor();
    expect(await reasonOf(() => caller.inbox.list({}))).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(await reasonOf(() => caller.clock.get())).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(await reasonOf(() => caller.account.session())).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(await reasonOf(() => caller.phone.status())).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(await reasonOf(() => caller.phone.sendCode({}))).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(await reasonOf(() => caller.phone.verify({ code: "123456" }))).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(r.sms.outbox).toHaveLength(sent);
    expect(r.audit.entries.filter((entry) => entry.action === "DENY").map((entry) => entry.outcome)).toContain("ACCOUNT_BLOCKED");
  });

  it("[FL-132] a block the container's staff cache has not seen yet still stops every SMS and every code", async () => {
    const r = await setup();
    await r.connector.worlds.setStaffBlocked("demo", "stf-operator-01", true);
    const caller = await r.callerFor();
    expect(await reasonOf(() => caller.phone.sendCode({ phone: "+54 9 11 5555-0100" }))).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(await reasonOf(() => caller.phone.verify({ code: "123456" }))).toBe(AUTH_REASON.ACCOUNT_BLOCKED);
    expect(r.sms.outbox).toEqual([]);
  });

  it("[FL-132] an unblocked account is back to the SMS code, its other attributes as they were", async () => {
    const r = await setup();
    await r.blockEverywhere();
    await r.connector.worlds.setStaffBlocked("demo", "stf-operator-01", false);
    r.directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", SUB));
    const caller = await r.callerFor();
    expect(await reasonOf(() => caller.inbox.list({}))).toBe(AUTH_REASON.PHONE_VERIFICATION_REQUIRED);
    expect(await caller.phone.sendCode({ phone: "+54 9 11 5555-0100" })).toMatchObject({ status: "CODE_SENT" });
    expect(await r.connector.worlds.getStaff("demo", "stf-operator-01")).toMatchObject({ active: true });
    expect(await r.connector.worlds.getStaff("demo", "stf-operator-01")).not.toHaveProperty("blocked");
  });
});
