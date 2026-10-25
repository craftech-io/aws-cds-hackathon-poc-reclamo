import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StaffRole } from "@reclamo/shared";
import { AUTH_REASON } from "../auth/errors";
import { type Principal, inProcessPrincipal } from "../auth/principal";
import { TEST_POOL, claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { appRouter, createCaller } from "./index";
import { ACCESS, type ProcedurePath } from "./roles";
import { RESET_STATUS_PATH, assertWorld, createContextFactory, createInProcessContext, router, worldProcedure } from "./trpc";

const { issuer, directory, audit, deps } = createTestDeps();
for (const [worldId, status] of [["g01", "READY"], ["g02", "READY"], ["g04", "RESETTING"], ["g05", "CREATING"], ["qa-r1-sc18", "READY"], ["qamin", "READY"], ["demo", "READY"]] as const) {
  directory.setWorld(worldId, status, 3);
}
directory.putStaff(staffRow("g01", "stf-guest-01", "GUEST", "sub-guest-01"));
directory.putStaff(staffRow("g02", "stf-guest-02", "GUEST", "sub-guest-02"));
directory.putStaff(staffRow("g04", "stf-guest-04", "GUEST", "sub-guest-04"));
directory.putStaff(staffRow("g05", "stf-guest-05", "GUEST", "sub-guest-05"));

const contextFor = createContextFactory(() => deps);
const guest = (n: string, extra: Record<string, unknown> = {}) =>
  issuer.idToken({ sub: `sub-guest-${n}`, ...claimsOf({ worldId: `g${n}`, staffId: `stf-guest-${n}`, role: "GUEST" }, `guest-${n}`), ...extra });

// Procedures that read an id of their input check it with `assertWorld`, as every router must.
const probe = router({
  whoami: worldProcedure.input(z.looseObject({})).query(({ ctx }) => ({ worldId: ctx.principal.worldId, staffId: ctx.principal.staffId, epoch: ctx.world.epoch })),
  item: worldProcedure.input(z.object({ worldId: z.string(), itemId: z.string() })).query(async ({ ctx, input, path }) => {
    await assertWorld(ctx, path, input.worldId);
    return { itemId: input.itemId, worldId: ctx.principal.worldId };
  }),
});

async function probeFor(token: string) {
  return probe.createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
}

async function failureOf(run: () => Promise<unknown>): Promise<{ status: number; reason: string | undefined }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    const reason: unknown = error.cause && typeof error.cause === "object" ? Reflect.get(error.cause, "reason") : undefined;
    return { status: getHTTPStatusCodeFromError(error), reason: typeof reason === "string" ? reason : undefined };
  }
  throw new Error("expected a refusal");
}

function callPath(caller: unknown, path: string): Promise<unknown> {
  const procedure: unknown = path.split(".").reduce<unknown>((node, key) => Reflect.get(node as object, key), caller);
  if (typeof procedure !== "function") throw new Error(`no procedure at ${path}`);
  return Promise.resolve(procedure(undefined));
}

const PATHS = Object.keys(ACCESS) as ProcedurePath[];
const AUTH_REASONS: ReadonlySet<string> = new Set(Object.values(AUTH_REASON));

/** True when the call got past authentication and the guards (whatever the procedure then answered). */
async function passesGuards(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return !(error.cause && typeof error.cause === "object" && AUTH_REASONS.has(String(Reflect.get(error.cause, "reason"))));
  }
}

describe("isolation between worlds in the console [FL-099]", () => {
  it("takes the world from the token, never from the input", async () => {
    const caller = await probeFor(guest("01"));
    expect(await caller.whoami({ worldId: "g02", staffId: "stf-guest-02" })).toEqual({ worldId: "g01", staffId: "stf-guest-01", epoch: 3 });
  });

  it("refuses an id of another world with 403 and audits DENY CROSS_WORLD in the caller's world", async () => {
    audit.entries.length = 0;
    const caller = await probeFor(guest("01"));
    expect(await caller.item({ worldId: "g01", itemId: "cmp-1" })).toEqual({ itemId: "cmp-1", worldId: "g01" });
    expect(await failureOf(() => caller.item({ worldId: "g02", itemId: "cmp-1" }))).toEqual({ status: 403, reason: AUTH_REASON.CROSS_WORLD });
    expect(audit.entries).toEqual([
      { worldId: "g01", epoch: 3, action: "DENY", outcome: "CROSS_WORLD", actor: "OPERATOR:stf-guest-01", refs: { path: "item", staffId: "stf-guest-01", reason: AUTH_REASON.CROSS_WORLD } },
    ]);
  });

  it("keeps two guests apart: a token for one world never reaches the staff row of another", async () => {
    // A token naming world g02 with the staff id of g01 finds no row in g02.
    const crossed = await probeFor(guest("01", { worldId: "g02" }));
    expect(await failureOf(() => crossed.whoami({}))).toEqual({ status: 403, reason: AUTH_REASON.STAFF_INACTIVE });
    // The sub of guest 02 with the claims of guest 01: the row belongs to another sub.
    const otherSub = await probeFor(guest("01", { sub: "sub-guest-02" }));
    expect(await failureOf(() => otherSub.whoami({}))).toEqual({ status: 403, reason: AUTH_REASON.STAFF_INACTIVE });
    expect((await (await probeFor(guest("02"))).whoami({})).worldId).toBe("g02");
  });

  it("stops a token as soon as its staff row is gone, without waiting for it to expire", async () => {
    directory.putStaff(staffRow("g02", "stf-guest-02b", "GUEST", "sub-guest-02b"));
    const token = issuer.idToken({ sub: "sub-guest-02b", ...claimsOf({ worldId: "g02", staffId: "stf-guest-02b", role: "GUEST" }, "guest-02b") });
    expect((await (await probeFor(token)).whoami({})).worldId).toBe("g02");
    directory.removeStaff("g02", "stf-guest-02b");
    expect(await failureOf(async () => (await probeFor(token)).whoami({}))).toEqual({ status: 403, reason: AUTH_REASON.STAFF_INACTIVE });
  });

  it("refuses every console procedure without a token", async () => {
    const caller = createCaller(await contextFor({ event: { headers: {} } }));
    for (const path of PATHS) expect(await failureOf(() => callPath(caller, path)), path).toEqual({ status: 401, reason: AUTH_REASON.TOKEN_MISSING });
  });

  it("answers WORLD_RESETTING to everything but clock.resetStatus and the guest's own world status while the world is being reset", async () => {
    const caller = createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${guest("04")}` } } }));
    for (const path of PATHS) {
      if (path === RESET_STATUS_PATH || path.startsWith("guest.")) expect(await passesGuards(() => callPath(caller, path)), path).toBe(true);
      else expect(await failureOf(() => callPath(caller, path)), path).toEqual({ status: 409, reason: AUTH_REASON.WORLD_RESETTING });
    }
  });

  it("answers WORLD_NOT_READY for a world still being created or without META", async () => {
    const creating = createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${guest("05")}` } } }));
    expect(await failureOf(() => creating.clock.resetStatus())).toEqual({ status: 409, reason: AUTH_REASON.WORLD_NOT_READY });
    directory.putStaff(staffRow("g06", "stf-guest-06", "GUEST", "sub-guest-06"));
    const missing = createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${guest("06")}` } } }));
    expect(await failureOf(() => missing.inbox.list())).toEqual({ status: 409, reason: AUTH_REASON.WORLD_NOT_READY });
  });

  it("refuses a ServerClient token in a guest world with 401 and audits it", async () => {
    audit.entries.length = 0;
    const caller = await probeFor(guest("01", { aud: TEST_POOL.serverClientId }));
    expect(await failureOf(() => caller.whoami({}))).toEqual({ status: 401, reason: AUTH_REASON.SERVER_CLIENT_AUDIENCE });
    expect(audit.entries).toEqual([expect.objectContaining({ worldId: "g01", action: "DENY", outcome: "SERVER_CLIENT_AUDIENCE" })]);
  });

  it("fails closed with 503 when the staff directory cannot be read, and keeps refusing if the audit write fails", async () => {
    directory.failWith(new Error("ThrottlingException"));
    expect(await failureOf(async () => (await probeFor(guest("01"))).whoami({}))).toEqual({ status: 503, reason: AUTH_REASON.AUTH_UNAVAILABLE });
    directory.failWith(undefined);
    audit.failWith(new Error("AccessDenied"));
    const caller = await probeFor(guest("01"));
    expect(await failureOf(() => caller.item({ worldId: "g02", itemId: "cmp-1" }))).toEqual({ status: 403, reason: AUTH_REASON.CROSS_WORLD });
    audit.failWith(undefined);
  });
});

describe("the QaDriver's in-process caller stays in QA worlds [FL-099]", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const inProcess = (principal: Principal) => createCaller(createInProcessContext({ principal, deps }));

  it("runs the real procedures, guards included, for a server-built principal in a QA world", async () => {
    const operator = inProcess(inProcessPrincipal({ worldId: "qa-r1-sc18", role: "OPERATOR", authTime: now() }));
    expect(await passesGuards(() => operator.inbox.list())).toBe(true);
    const compliance = inProcess(inProcessPrincipal({ worldId: "qa-r1-sc18", role: "COMPLIANCE", authTime: now() }));
    expect(await failureOf(() => compliance.complaints.note(undefined as never))).toEqual({ status: 403, reason: AUTH_REASON.READ_ONLY_ROLE });
    const stale = inProcess(inProcessPrincipal({ worldId: "qa-r1-sc18", role: "OPERATOR", authTime: now() - 20 * 60 }));
    expect(await failureOf(() => stale.approvals.decide(undefined as never))).toEqual({ status: 403, reason: AUTH_REASON.LOGIN_NOT_RECENT });
    const qamin = inProcess(inProcessPrincipal({ worldId: "qamin", role: "OPERATOR", authTime: now() }));
    expect(await passesGuards(() => qamin.clock.resetStatus())).toBe(true);
  });

  it.each<[string, StaffRole]>([
    ["demo", "OPERATOR"],
    ["g01", "GUEST"],
    ["gprobe", "OPERATOR"],
    ["gtest", "SUPERVISOR"],
    ["qamin", "GUEST"],
  ])("refuses %s as %s even with a principal forged past the builder", async (worldId, role) => {
    const forged: Principal = { ...inProcessPrincipal({ worldId: "qa-r1-sc18", role: "OPERATOR", authTime: now() }), worldId, role };
    expect(await failureOf(() => inProcess(forged).inbox.list())).toEqual({ status: 403, reason: AUTH_REASON.IN_PROCESS_WORLD_DENIED });
  });

  it("is reachable only through createInProcessContext: an HTTP request never carries a principal", async () => {
    const context = await contextFor({ event: { headers: { "x-principal": JSON.stringify({ worldId: "qa-r1-sc18", role: "OPERATOR" }) } } });
    expect(context.inProcess).toBeNull();
    expect(Object.keys(appRouter._def.procedures)).not.toContain("qa");
  });
});
