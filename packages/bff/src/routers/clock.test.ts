// `clock.*` (FL-082, FL-100; docs/architecture.md §10): the console's moves of a world's clock with the
// `WORLD_BUSY` gate, the live clock, and the reset that only writes its request, invokes `WorldJanitor`
// asynchronously and answers 202 without waiting for (or even importing) the work.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { ClockSnapshot, ResetStatus, clockViewOf, resetFinished } from "../../../web/src/lib/world-clock";
import { complaint, timer } from "../connector/testing";
import { inFlightToken } from "../worker/events";
import { createHandler } from "./handler";
import { appRouter } from "./index";
import { type ConsoleRig, COMPLIANCE, GUEST, OPERATOR, consoleRig, refusalOf } from "./testing";

const MINUTE = 60_000;
const follow = (timerId: string, dueAtSim: string) => timer("g03", { kind: "FOLLOW_UP", timerId, dueAtSim, seq: 0, ownerKey: "CMP#cmp-0001", payload: { complaintId: "cmp-0001", customerId: "cus-0001" } });

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("g03");
  await rig.seedWorld("demo");
  await rig.connector.transact([rig.connector.complaints.createOp(complaint("g03", { status: "AWAITING_NETWORK" }))]);
  await rig.connector.timers.put(follow("f-1", "2026-10-07T10:40:00-03:00"));
  await rig.connector.timers.put(follow("f-2", "2026-10-08T08:30:00-03:00"));
});

describe("clock.get and the moves [FL-082]", () => {
  it("[FL-082] shows mode, simulated now, the next timers and a quiet world", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const quiet = await caller.clock.get();
    expect(quiet).toMatchObject({ worldId: "demo", mode: "PAUSED", busy: null, upcoming: [] });
    expect(quiet).not.toHaveProperty("rate");
    const guest = (await rig.as(GUEST)).caller;
    const view = await guest.clock.get();
    expect(view).toMatchObject({ worldId: "g03", worldEpoch: 1, mode: "PAUSED", simNow: "2026-10-07T10:10:00-03:00" });
    expect(view.upcoming.map((item) => [item.timerId, item.complaintId])).toEqual([["f-1", "cmp-0001"], ["f-2", "cmp-0001"]]);
  });

  it("[FL-082] moves forward and fires what fell due at its own instant, audited", async () => {
    const { caller } = await rig.as(GUEST);
    const moved = await caller.clock.advance({ minutes: 60 });
    expect(moved).toMatchObject({ mode: "PAUSED", simNow: "2026-10-07T11:10:00-03:00", fired: [expect.objectContaining({ timerId: "f-1", status: "FIRED" })], forced: false });
    expect(rig.queue.map((event) => event.eventAtSim)).toEqual(["2026-10-07T10:40:00-03:00"]);
    expect(await rig.connector.audit.listByAction("g03", "CLOCK_ADVANCED")).toEqual([expect.objectContaining({ actor: "OPERATOR:stf-guest-03" })]);
    await expect(caller.clock.advance({ minutes: 20 * 24 * 60 + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await refusalOf(() => caller.clock.advanceTo({ to: "2026-10-07T09:00:00-03:00" }))).toBe("CLOCK_BACKWARDS");
  });

  it("[FL-082] goes to the next milestone of one complaint ('Avanzar al próximo hito de este reclamo')", async () => {
    const { caller } = await rig.as(GUEST);
    expect(await caller.clock.advanceToNext({ complaintId: "cmp-0001" })).toMatchObject({ simNow: "2026-10-07T10:40:00-03:00" });
    expect(await caller.clock.advanceToNext({ complaintId: "cmp-0001" })).toMatchObject({ simNow: "2026-10-08T08:30:00-03:00" });
    expect(await refusalOf(() => caller.clock.advanceToNext({ complaintId: "cmp-0001" }))).toBe("CLOCK_NOTHING_PENDING");
    expect(await refusalOf(() => caller.clock.advanceToNext({ complaintId: "cmp-9999" }))).toBe("COMPLAINT_NOT_FOUND");
  });

  it("[FL-082] fires one timer now by moving to its instant, firing in order what falls due before", async () => {
    const { caller } = await rig.as(GUEST);
    const moved = await caller.clock.fireNow({ kind: "FOLLOW_UP", timerId: "f-2" });
    expect(moved.fired.map((ref) => ref.timerId)).toEqual(["f-1", "f-2"]);
    expect(await refusalOf(() => caller.clock.fireNow({ kind: "FOLLOW_UP", timerId: "f-2" }))).toBe("TIMER_NOT_SCHEDULED");
  });

  it("[FL-082] refuses a move of a busy world with WORLD_BUSY and its pending list; 'Avanzar igual' only after 5 real minutes, audited", async () => {
    await rig.connector.write(rig.connector.runtime.addInFlightOp("g03", inFlightToken({ customerId: "cus-0001", eventId: "evt-1" }, rig.now())));
    const { caller } = await rig.as(GUEST);
    expect(await refusalOf(() => caller.clock.advance({ minutes: 60 }))).toBe("WORLD_BUSY");
    const view = await caller.clock.get();
    expect(view.busy).toMatchObject({ reason: "EVENT_IN_FLIGHT", pending: [expect.objectContaining({ kind: "EVENT", detail: "evt-1" })] });
    expect(Date.parse(view.busy?.forceAllowedAtReal ?? "")).toBe(rig.now().getTime() + 5 * MINUTE);
    expect(await refusalOf(() => caller.clock.advance({ minutes: 60, force: true }))).toBe("WORLD_BUSY");
    rig.passReal(5 * MINUTE);
    expect(await caller.clock.advance({ minutes: 60, force: true })).toMatchObject({ forced: true });
    expect(await rig.connector.audit.listByAction("g03", "CLOCK_FORCED")).toHaveLength(1);
  });

  it("[FL-082] runs live at a bounded rate with its schedules, and pauses", async () => {
    const { caller } = await rig.as(GUEST);
    await expect(caller.clock.setRunning({ rate: 2_881 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await caller.clock.setRunning({ rate: 288 })).toMatchObject({ mode: "RUNNING", rate: 288 });
    expect(await caller.clock.get()).toMatchObject({ mode: "RUNNING", rate: 288 });
    expect(rig.scheduler.puts.length).toBeGreaterThan(0);
    expect(await caller.clock.pause()).toMatchObject({ mode: "PAUSED" });
    rig.passReal(31 * MINUTE);
    expect((await caller.clock.get()).mode).toBe("PAUSED");
  });

  it("[FL-082] answers what the console's clock bar reads, quiet and busy", async () => {
    const { caller } = await rig.as(GUEST);
    expect(clockViewOf(await caller.clock.get())).toMatchObject({ mode: "PAUSED", busyReason: undefined });
    await rig.connector.write(rig.connector.runtime.addInFlightOp("g03", inFlightToken({ customerId: "cus-0001", eventId: "evt-2" }, rig.now())));
    const busy = await (await rig.as(GUEST)).caller.clock.get();
    expect(ClockSnapshot.safeParse(busy).success).toBe(true);
    expect(clockViewOf(busy)?.busyReason).toBe("EVENT_IN_FLIGHT");
  });

  it("keeps COMPLIANCE away from every move", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    expect(await refusalOf(() => caller.clock.advance({ minutes: 1 }))).toBe("READ_ONLY_ROLE");
  });
});

describe("clock.reset [FL-100]", () => {
  it("[FL-100] writes only the request, invokes WorldJanitor asynchronously with {kind, worldId, requestId} and answers 202", async () => {
    const handler = createHandler(appRouter, rig.contextFor);
    const event = {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/api/clock.reset",
      rawQueryString: "",
      headers: { authorization: `Bearer ${rig.tokenOf(GUEST)}`, "content-type": "application/json" },
      body: "{}",
      isBase64Encoded: false,
      requestContext: { http: { method: "POST", path: "/api/clock.reset", protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" }, requestId: "req-reset-1" },
    } as unknown as APIGatewayProxyEventV2;
    const response = await handler(event, { awsRequestId: "req-reset-1" } as LambdaContext);
    expect(response.statusCode).toBe(202);
    const meta = await rig.connector.worlds.getMeta("g03", { consistent: true });
    expect(meta).toMatchObject({ status: "RESETTING", reset: { phase: "WIPE", fromEpoch: 1, toEpoch: 2 } });
    const requestId = meta?.reset?.requestId ?? "";
    expect(response.body).toContain(requestId);
    expect(rig.janitor).toEqual([{ kind: "WORLD_RESET", worldId: "g03", requestId }]);
    expect(await rig.connector.counters.getEpoch("g03")).toBe(2);
    expect(await rig.connector.runtime.getTombstone("g03", 1)).toBeDefined();
    expect(await rig.connector.counters.getTicket("g03", "RESETREQ", requestId)).toMatchObject({ status: "OPEN" });
    expect(await rig.connector.audit.listByAction("g03", "WORLD_RESET_REQUESTED")).toHaveLength(1);
    // Nothing of the work ran: the world's data is all still there.
    expect(await rig.connector.complaints.get("g03", "cmp-0001")).toBeDefined();
    expect((await rig.connector.timers.listDue("g03")).length).toBe(2);
  });

  it("[FL-100] answers only clock.resetStatus while RESETTING, then RATE_LIMITED for 10 minutes after the reset ended", async () => {
    const requested = await (await rig.as(GUEST)).caller.clock.reset();
    expect(requested.status).toBe("RESETTING");
    // A new request (one context memoizes the world it authenticated against).
    const caller = (await rig.as(GUEST)).caller;
    expect(await refusalOf(() => caller.clock.get())).toBe("WORLD_RESETTING");
    expect(await caller.clock.resetStatus()).toEqual({ status: "RESETTING", phase: "WIPE", requestId: requested.requestId, startedAtReal: rig.now().toISOString() });
    expect(ResetStatus.safeParse(await caller.clock.resetStatus()).success).toBe(true);
    await rig.connector.worlds.changeMeta({ worldId: "g03", from: "RESETTING", to: "READY", resetRequestId: requested.requestId, set: { lastResetAtReal: rig.now().toISOString() }, remove: ["reset"] });
    expect(resetFinished(await (await rig.as(GUEST)).caller.clock.resetStatus())).toBe(true);
    expect(await refusalOf(async () => (await rig.as(GUEST)).caller.clock.reset())).toBe("RATE_LIMITED");
    rig.passReal(10 * MINUTE + 1);
    expect(await refusalOf(async () => (await rig.as(GUEST)).caller.clock.reset())).toBeNull();
  });

  it("[FL-100] needs a sign-in of at most 15 minutes and only touches the principal's own world", async () => {
    const stale = (await rig.as(GUEST, 20 * 60)).caller;
    expect(await refusalOf(() => stale.clock.reset())).toBe("LOGIN_NOT_RECENT");
    const operator = (await rig.as(OPERATOR)).caller;
    await operator.clock.reset();
    expect((await rig.connector.worlds.getMeta("demo"))?.status).toBe("RESETTING");
    expect((await rig.connector.worlds.getMeta("g03"))?.status).toBe("READY");
  });

  it("[FL-100] never reaches the world factory: no import path from the router to worlds/factory.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const pending = [resolve(here, "clock.ts")];
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(/^(?:import|export)[^;]*?from "(\.{1,2}\/[^"]+)"/gm)) {
        const target = resolve(dirname(file), `${match[1]}.ts`);
        if (existsSync(target)) pending.push(target);
      }
    }
    expect(seen.has(join(here, "..", "worlds", "reset.ts"))).toBe(true);
    expect([...seen].filter((file) => file.endsWith(join("worlds", "factory.ts")))).toEqual([]);
  });
});
