// Caps of the self-signup (FL-114, FL-117, FL-118): never past the limit under a race, real clock
// only; the quota of guest worlds is the factory's and never refuses a sign-up.
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { worldMeta } from "../connector/testing";
import { signupRuntimeKeys } from "../leads/keys";
import { SIGNUP_LIMITS } from "../leads/limits";
import { createSignupHarness, startInput } from "./testing/harness";

describe("sign-up caps [FL-118] [FL-114]", () => {
  it("never counts past a limit when 50 requests race", async () => {
    const harness = await createSignupHarness().ready();
    const key = signupRuntimeKeys.globalHour(harness.now());
    const results = await Promise.all(Array.from({ length: 50 }, () => harness.caps.take({ key, limit: SIGNUP_LIMITS.globalPerHour })));
    expect(results.filter(Boolean)).toHaveLength(SIGNUP_LIMITS.globalPerHour);
    expect(await harness.caps.count(key)).toBe(SIGNUP_LIMITS.globalPerHour);
  });

  it("windows by the real hour and day, and resends by account: 3 an hour, 5 a day", async () => {
    const harness = await createSignupHarness().ready();
    for (let n = 0; n < 3; n += 1) expect(await harness.caps.resend("sub-1")).toBe(true);
    expect(await harness.caps.resend("sub-1")).toBe(false);
    harness.advance(3_600_000);
    expect(await harness.caps.resend("sub-1")).toBe(true);
    expect(await harness.caps.resend("sub-1")).toBe(true);
    expect(await harness.caps.resend("sub-1")).toBe(false);
    expect(await harness.caps.resend("sub-2")).toBe(true);
  });

  it("reads the auth-mail cap without spending it, and spends it only when asked", async () => {
    const harness = await createSignupHarness().ready();
    expect(await harness.caps.authMailOpen()).toBe(true);
    expect(await harness.caps.count(signupRuntimeKeys.authMailHour(harness.now()))).toBe(0);
    expect(await harness.caps.spendAuthMail()).toBe(true);
    expect(await harness.caps.count(signupRuntimeKeys.authMailDay(harness.now()))).toBe(1);
  });

  it("stays closed without the switch, and with the kill on", async () => {
    const closed = await createSignupHarness({ open: false }).ready();
    expect(await closed.caps.signupOpen()).toBe(false);
    await closed.setOpen(true);
    expect(await closed.caps.signupOpen()).toBe(true);
    // The row the budget or the SES alarms write: its presence closes the sign-up, whatever it holds.
    await closed.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.kill(), entity: "Kill", by: "BUDGET", atReal: "2026-10-07T13:10:00.000Z" } });
    expect(await closed.caps.signupOpen()).toBe(false);
  });

  it("a request refused by a narrow cap spends nothing of the global ones", async () => {
    const harness = await createSignupHarness().ready();
    for (let n = 0; n < 40; n += 1) await harness.caps.signupRequest("ip-a", `canon-${n}`);
    expect(await harness.caps.count(signupRuntimeKeys.globalHour(harness.now()))).toBe(SIGNUP_LIMITS.perIpPerDay);
    expect(await harness.caps.count(signupRuntimeKeys.globalDay(harness.now()))).toBe(SIGNUP_LIMITS.perIpPerDay);
    expect(await harness.caps.signupRequest("ip-b", "canon-b")).toBe(true);
  });

  it("a full global cap refuses without touching the per-IP one", async () => {
    const harness = await createSignupHarness().ready();
    await harness.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.globalHour(harness.now()), count: SIGNUP_LIMITS.globalPerHour } });
    expect(await harness.caps.signupRequest("ip-a", "canon-a")).toBe(false);
    expect(await harness.caps.count(signupRuntimeKeys.ipDay("ip-a", harness.now()))).toBe(0);
  });

  it("gives back what it took when a race fills a later counter", async () => {
    const harness = await createSignupHarness().ready();
    const day = { key: signupRuntimeKeys.globalDay(harness.now()), limit: 1 };
    const hour = { key: signupRuntimeKeys.globalHour(harness.now()), limit: 5 };
    const results = await Promise.all([harness.caps.takeAll([hour, day]), harness.caps.takeAll([hour, day])]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await harness.caps.count(hour.key)).toBe(1);
  });

  it("a resend refused by the hour does not spend the day", async () => {
    const harness = await createSignupHarness().ready();
    for (let n = 0; n < 6; n += 1) await harness.caps.resend("sub-1");
    expect(await harness.caps.count(signupRuntimeKeys.accountDay("sub-1", "RESEND", harness.now()))).toBe(SIGNUP_LIMITS.resendPerHour);
  });
});

describe("a full quota of guest worlds never stops a sign-up: the world waits in the queue [FL-117]", () => {
  it("[FL-117] registers the world REGISTERED in GuestIndex with an OPEN ticket, whatever GUESTCAP#ACTIVE says", async () => {
    const harness = await createSignupHarness().ready();
    // 40 active and 3 creating: the factory's quota is full (WorldJanitor's counter, never the sign-up's).
    await harness.store.write({ kind: "put", table: "Runtime", item: { pk: "GUESTCAP#ACTIVE", sk: "META", active: 40, creating: 3 } });
    const email = "ana.prospecto@empresa-ficticia.ar";
    const started = await harness.signup.start(startInput({ email }), "203.0.113.7");
    if (started.status !== "CODE_SENT") throw new Error(started.status);
    expect(await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode(email) ?? "" })).toMatchObject({ status: "CONFIRMED", worldStatus: "REGISTERED" });
    const worldId = harness.hashes.guestWorldId(harness.cognito.user(email)?.sub ?? "");
    const meta = await harness.store.get("Worlds", keys.worldMeta(worldId));
    expect(meta).toMatchObject({ status: "REGISTERED", guestIndexKey: "GUEST#REGISTERED" });
    expect(String(meta?.guestIndexSort)).toMatch(new RegExp(`#${worldId}$`));
    expect(harness.invoked.worlds).toEqual([expect.objectContaining({ kind: "WORLD_CREATE", worldId })]);
    const requestId = harness.invoked.worlds[0]?.requestId ?? "";
    expect(await harness.store.get("Runtime", keys.runtime(worldId, "PROVISIONREQ", requestId))).toMatchObject({ status: "OPEN", attempts: 0 });
    expect(await harness.store.get("Runtime", { pk: "GUESTCAP#ACTIVE", sk: "META" })).toMatchObject({ active: 40, creating: 3 });
  });

  it("[FL-117] guest.status shows the position the factory wrote while the world waits", async () => {
    const harness = await createSignupHarness().ready();
    await harness.connector.worlds.register(worldMeta("gs-abcdefgh23", { status: "REGISTERED", queuePosition: 4 }));
    const caller = { sub: "3b7c1d2e-0000-4000-8000-00000000c001", worldId: "gs-abcdefgh23", sessionId: "0d1c2b3a-0000-4000-8000-00000000a001" };
    expect(await harness.guestWorld.status(caller)).toEqual({ worldStatus: "REGISTERED", queuePosition: 4 });
  });
});

