// A self-signup guest in the console (FL-120, FL-121, FL-123, FL-124): while its world is not READY
// only `guest.status`, `guest.requestWorld` and `account.session` answer; the rest says
// WORLD_NOT_READY. After "Salir" the console holds no token and every guest procedure refuses.
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { createTestDeps, staffRow } from "../auth/testing";
import { keys } from "../connector/keys";
import { createSignupHarness, startInput } from "../guests/testing/harness";
import { createCaller } from "./index";
import { createContextFactory } from "./trpc";

const SUB = "3b7c1d2e-0000-4000-8000-00000000c001";
const WORLD = "gs-abcdefgh23";

async function setup(status: "REGISTERED" | "READY", signedOut = false) {
  const { issuer, directory, deps } = createTestDeps();
  const harness = await createSignupHarness().ready();
  directory.putStaff(staffRow(WORLD, `stf-${WORLD}`, "GUEST", SUB));
  directory.setWorld(WORLD, status);
  const contextFor = createContextFactory(() => ({ ...deps, guestWorldOf: () => WORLD, guestWorld: () => harness.guestWorld }));
  const token = issuer.idToken({ sub: SUB, "cognito:username": "ana@empresa-ficticia.ar", "cognito:groups": undefined, worldId: WORLD, staffId: `stf-${WORLD}`, role: "GUEST" });
  const caller = createCaller(await contextFor({ event: { headers: signedOut ? {} : { authorization: `Bearer ${token}` } } }));
  return { caller };
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

describe("guest procedures of a self-signup world [FL-120] [FL-121]", () => {
  it("answers guest.status while REGISTERED and refuses the views with WORLD_NOT_READY", async () => {
    const { caller } = await setup("REGISTERED");
    expect(await caller.guest.status()).toMatchObject({ worldStatus: "REGISTERED" });
    expect(await reasonOf(() => caller.inbox.list())).toBe("WORLD_NOT_READY");
    expect(await reasonOf(() => caller.account.session())).not.toBe("WORLD_NOT_READY");
    expect(await caller.guest.requestWorld()).toEqual({ status: "ALREADY_ACTIVE" });
  });

  it("opens the console once the world is READY", async () => {
    const { caller } = await setup("READY");
    expect(await reasonOf(() => caller.inbox.list())).not.toBe("WORLD_NOT_READY");
  });
});

describe("an expired self-signup world asked for again [FL-124]", () => {
  it("refuses the views and lets guest.requestWorld register the world again", async () => {
    const harness = await createSignupHarness().ready();
    const email = "ana.prospecto@empresa-ficticia.ar";
    const started = await harness.signup.start(startInput(), "203.0.113.7");
    if (started.status !== "CODE_SENT") throw new Error(started.status);
    await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode(email) ?? "" });
    const sub = harness.cognito.user(email)?.sub ?? "";
    const worldId = harness.hashes.guestWorldId(sub);
    await harness.store.write({ kind: "update", table: "Worlds", key: keys.worldMeta(worldId), update: { set: { status: "EXPIRED" } } });

    const { issuer, directory, deps } = createTestDeps();
    directory.putStaff(staffRow(worldId, `stf-${worldId}`, "GUEST", sub));
    directory.setWorld(worldId, "EXPIRED");
    const contextFor = createContextFactory(() => ({ ...deps, guestWorldOf: () => worldId, guestWorld: () => harness.guestWorld }));
    const token = issuer.idToken({ sub, "cognito:username": email, "cognito:groups": undefined, worldId, staffId: `stf-${worldId}`, role: "GUEST" });
    const caller = createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));

    expect(await reasonOf(() => caller.inbox.list())).toBe("WORLD_NOT_READY");
    expect(await caller.guest.requestWorld()).toEqual({ status: "REGISTERED" });
    expect((await harness.connector.worlds.getMeta(worldId))?.status).toBe("REGISTERED");
    expect(harness.invoked.worlds).toHaveLength(2);
  });
});

describe("after Salir [FL-123]", () => {
  it("refuses every guest procedure to a console without a token", async () => {
    const { caller } = await setup("READY", true);
    expect(await reasonOf(() => caller.guest.status())).toBe("TOKEN_MISSING");
    expect(await reasonOf(() => caller.guest.requestWorld())).toBe("TOKEN_MISSING");
  });
});
