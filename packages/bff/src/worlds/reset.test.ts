import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import type { Connector } from "../connector/port";
import { approval, complaint } from "../connector/testing";
import { createWorld } from "./create";
import { UNLIMITED } from "./deps";
import { RESET_DAILY_CAP, requestWorldReset, resumeStaleReset } from "./reset";
import { runWorldReset } from "./reset-work";
import { budgetOf, smallTemplate, worldsRig } from "./testing";
import { parseTemplate } from "./template";

const template = () => parseTemplate(smallTemplate("guest"), "guest");
const coreCount = () => template().items.filter((row) => row.table === "Core").length + template().items.filter((row) => row.entity === "Customer").length;

async function readyWorld(worldId = "g01") {
  const rig = worldsRig();
  await rig.mc.connector.worlds.register({ worldId, kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED" });
  await rig.mc.connector.worlds.putStaff({ worldId, staffId: "stf-guest-01", role: "GUEST", displayName: "Guest 01", cognitoSubKey: "SUB#sub-guest-01", active: true });
  await createWorld(rig.deps, { worldId, budget: UNLIMITED });
  return rig;
}

async function coreKeys(rig: ReturnType<typeof worldsRig>, worldId: string) {
  const out = [];
  let cursor: string | undefined;
  do {
    const page = await rig.mc.connector.worldItems.listKeys("Core", worldId, { limit: 500, ...(cursor ? { cursor } : {}) });
    out.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

describe("reset_world: the request [FL-100]", () => {
  it("[FL-100] commits READY → RESETTING, epoch + 1, tombstone, ticket and audit entry in one transaction", async () => {
    const rig = await readyWorld();
    const requested = await requestWorldReset(rig.deps, { worldId: "g01", actor: "OPERATOR:stf-guest-01" });
    expect(requested).toMatchObject({ status: "RESETTING", fromEpoch: 1, toEpoch: 2 });
    const meta = await rig.mc.connector.worlds.getMeta("g01", { consistent: true });
    expect(meta).toMatchObject({ status: "RESETTING", epoch: 1, reset: { requestId: requested.requestId, fromEpoch: 1, toEpoch: 2, phase: "WIPE", attempts: 0 } });
    expect(await rig.mc.connector.counters.getEpoch("g01")).toBe(2);
    expect(await rig.mc.connector.runtime.getTombstone("g01", 1)).toMatchObject({ reason: "RESET" });
    expect(await rig.mc.connector.counters.getTicket("g01", "RESETREQ", requested.requestId)).toMatchObject({ status: "OPEN" });
    expect(await rig.mc.connector.audit.listByAction("g01", "WORLD_RESET_REQUESTED")).toHaveLength(1);
  });

  it("[FL-100] refuses a second request while the world is resetting, and a world that is not READY", async () => {
    const rig = await readyWorld();
    await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await expect(requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" })).rejects.toMatchObject({ code: "CONFLICT", reason: "WORLD_RESETTING" });
    await expect(requestWorldReset(rig.deps, { worldId: "g09", actor: "SYSTEM" })).rejects.toMatchObject({ code: "CONFLICT", reason: "WORLD_NOT_READY" });
    expect(await rig.mc.connector.counters.getEpoch("g01")).toBe(2);
  });
});

describe("reset_world: the daily cap of a self-signup world [FL-125]", () => {
  const SIGNUP = "gs-abcdefgh23";
  const capKey = (at: Date) => keys.runtime(SIGNUP, "RESETCAP", at.toISOString().slice(0, 10));

  async function resetOnce(rig: ReturnType<typeof worldsRig>, worldId: string, deps = rig.deps) {
    const { requestId } = await requestWorldReset(deps, { worldId, actor: "OPERATOR:stf-guest-01" });
    expect((await runWorldReset(rig.deps, { worldId, requestId }, UNLIMITED)).status).toBe("READY");
    rig.advance(11 * 60_000);
  }

  it("[FL-125] counts every reset in W#<w>#RESETCAP#<realDay> and refuses the fourth of the real day with RESET_DAILY_CAP, writing nothing", async () => {
    const rig = await readyWorld(SIGNUP);
    for (let n = 0; n < 3; n += 1) await resetOnce(rig, SIGNUP);
    expect(await rig.mc.store.get("Runtime", capKey(rig.now()), { consistent: true })).toMatchObject({ count: 3, entity: "CapCounter" });
    const epoch = await rig.mc.connector.counters.getEpoch(SIGNUP);
    await expect(requestWorldReset(rig.deps, { worldId: SIGNUP, actor: "OPERATOR:stf-guest-01" })).rejects.toMatchObject({ code: "CONFLICT", reason: RESET_DAILY_CAP });
    expect(await rig.mc.connector.counters.getEpoch(SIGNUP)).toBe(epoch);
    expect((await rig.mc.connector.worlds.getMeta(SIGNUP, { consistent: true }))?.status).toBe("READY");
    expect(await rig.mc.connector.audit.listByAction(SIGNUP, "WORLD_RESET_REQUESTED")).toHaveLength(3);
    expect(await rig.mc.store.get("Runtime", capKey(rig.now()), { consistent: true })).toMatchObject({ count: 3 });
  });

  it("[FL-125] opens a new bucket only on the next REAL day", async () => {
    const rig = await readyWorld(SIGNUP);
    for (let n = 0; n < 3; n += 1) await resetOnce(rig, SIGNUP);
    await expect(requestWorldReset(rig.deps, { worldId: SIGNUP, actor: "OPERATOR:stf-guest-01" })).rejects.toMatchObject({ reason: RESET_DAILY_CAP });
    rig.advance(24 * 3_600_000);
    await expect(requestWorldReset(rig.deps, { worldId: SIGNUP, actor: "OPERATOR:stf-guest-01" })).resolves.toMatchObject({ status: "RESETTING" });
    expect(await rig.mc.store.get("Runtime", capKey(rig.now()), { consistent: true })).toMatchObject({ count: 1 });
  });

  it("[FL-125] holds the cap in the transaction when another request counted after the check", async () => {
    const rig = await readyWorld(SIGNUP);
    for (let n = 0; n < 3; n += 1) await resetOnce(rig, SIGNUP);
    let peeks = 0;
    const caps: Connector["caps"] = { ...rig.mc.connector.caps, peek: async (bucket) => (peeks++ === 0 ? 0 : rig.mc.connector.caps.peek(bucket)) };
    const racing = { ...rig.deps, connector: { ...rig.mc.connector, caps } };
    const epoch = await rig.mc.connector.counters.getEpoch(SIGNUP);
    await expect(requestWorldReset(racing, { worldId: SIGNUP, actor: "OPERATOR:stf-guest-01" })).rejects.toMatchObject({ reason: RESET_DAILY_CAP });
    expect(await rig.mc.connector.counters.getEpoch(SIGNUP)).toBe(epoch);
    expect((await rig.mc.connector.worlds.getMeta(SIGNUP, { consistent: true }))?.status).toBe("READY");
  });

  it("[FL-125] never counts a refused request, an invited guest world or an expiry", async () => {
    const rig = await readyWorld(SIGNUP);
    await requestWorldReset(rig.deps, { worldId: SIGNUP, actor: "OPERATOR:stf-guest-01" });
    await expect(requestWorldReset(rig.deps, { worldId: SIGNUP, actor: "OPERATOR:stf-guest-01" })).rejects.toMatchObject({ reason: "WORLD_RESETTING" });
    expect(await rig.mc.store.get("Runtime", capKey(rig.now()), { consistent: true })).toMatchObject({ count: 1 });

    const invited = await readyWorld("g01");
    for (let n = 0; n < 4; n += 1) await resetOnce(invited, "g01");
    expect(await invited.mc.store.get("Runtime", keys.runtime("g01", "RESETCAP", invited.now().toISOString().slice(0, 10)), { consistent: true })).toBeUndefined();

    const expiring = await readyWorld(SIGNUP);
    await requestWorldReset(expiring.deps, { worldId: SIGNUP, actor: "SYSTEM", kind: "EXPIRE" });
    expect(await expiring.mc.store.get("Runtime", capKey(expiring.now()), { consistent: true })).toBeUndefined();
  });
});

describe("reset_world: the work in WorldJanitor [FL-100]", () => {
  it("[FL-100] refuses to work without the ticket (RESET_REQUEST_MISSING) and changes nothing", async () => {
    const rig = await readyWorld();
    const result = await runWorldReset(rig.deps, { worldId: "g01", requestId: "01K7ZZZZZZZZZZZZZZZZZZZZZZ" }, UNLIMITED);
    expect(result).toEqual({ status: "MISSING" });
    expect(await rig.mc.connector.audit.listByAction("g01", "RESET_REQUEST_MISSING")).toHaveLength(1);
    expect((await rig.mc.connector.worlds.getMeta("g01", { consistent: true }))?.status).toBe("READY");
    expect(await coreKeys(rig, "g01")).toHaveLength(coreCount());
  });

  it("[FL-100] keeps META, SETTINGS and every STAFF# row through WIPE, and is never READY before the last phase", async () => {
    const rig = await readyWorld();
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    const seen: Record<string, unknown>[] = [];
    const deleteUnder = rig.deps.objects.deleteUnder;
    // OBJECTS starts right after WIPE: a snapshot of what WIPE left.
    const deps = {
      ...rig.deps,
      objects: {
        ...rig.deps.objects,
        deleteUnder: async (prefix: string, limit: number) => {
          if (seen.length === 0) {
            const meta = await rig.mc.connector.worlds.getMeta("g01", { consistent: true });
            seen.push({
              status: meta?.status,
              settings: (await rig.mc.connector.worlds.getSettings("g01")) !== undefined,
              staff: (await rig.mc.connector.worlds.listStaff("g01")).map((row) => row.staffId),
              core: (await coreKeys(rig, "g01")).length,
            });
          }
          return deleteUnder(prefix, limit);
        },
      },
    };
    const done = await runWorldReset(deps, { worldId: "g01", requestId }, UNLIMITED);
    expect(seen[0]).toEqual({ status: "RESETTING", settings: true, staff: ["stf-guest-01"], core: 0 });
    expect(done.status).toBe("READY");
    const meta = await rig.mc.connector.worlds.getMeta("g01", { consistent: true });
    expect(meta).toMatchObject({ status: "READY", epoch: 2 });
    expect(meta?.reset).toBeUndefined();
    expect(await rig.mc.connector.worlds.listStaff("g01")).toHaveLength(1);
    expect(await coreKeys(rig, "g01")).toHaveLength(coreCount());
    expect((await rig.mc.connector.chains.readHead("g01", 2, "REG"))?.value).toBe(template().items.filter((row) => row.entity === "RegisterEntry").length);
    // The old epoch's register is append-only: it stays in its own partition.
    expect((await rig.mc.connector.chains.readHead("g01", 1, "REG"))?.value).toBe(template().items.filter((row) => row.entity === "RegisterEntry").length);
    expect(await rig.mc.connector.counters.getTicket("g01", "RESETREQ", requestId)).toMatchObject({ status: "DONE" });
    expect(await rig.mc.connector.audit.listByAction("g01", "WORLD_RESET")).toHaveLength(1);
    expect(rig.logs.some((line) => line.includes("WorldResetDuration"))).toBe(true);
  });

  it("[FL-100] a run cut in WIPE continues with the same ticket and ends with the template's manifest, no duplicates", async () => {
    const rig = await readyWorld();
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    const cut = await runWorldReset(rig.deps, { worldId: "g01", requestId }, budgetOf(3));
    expect(cut).toEqual({ status: "CONTINUED", phase: "WIPE" });
    expect(rig.invoked).toContainEqual({ kind: "WORLD_RESET", worldId: "g01", requestId });
    expect(await rig.mc.connector.counters.getTicket("g01", "RESETREQ", requestId)).toMatchObject({ status: "OPEN" });
    expect((await rig.mc.connector.worlds.getMeta("g01", { consistent: true }))?.status).toBe("RESETTING");

    expect((await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED)).status).toBe("READY");
    expect(await coreKeys(rig, "g01")).toHaveLength(coreCount());
  });

  it("[FL-100] a run cut halfway through RELOAD resumes from its cursor and is READY only at the end", async () => {
    const rig = await readyWorld();
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    // Enough for WIPE and OBJECTS, then a few blocks of the reload.
    const cut = await runWorldReset(rig.deps, { worldId: "g01", requestId }, budgetOf(30));
    expect(cut).toEqual({ status: "CONTINUED", phase: "RELOAD" });
    const half = await rig.mc.connector.worlds.getMeta("g01", { consistent: true });
    expect(half).toMatchObject({ status: "RESETTING", reset: { phase: "RELOAD" } });
    expect(half?.buildCursor).toBeDefined();

    expect((await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED)).status).toBe("READY");
    expect(await coreKeys(rig, "g01")).toHaveLength(coreCount());
    expect((await rig.mc.connector.chains.readHead("g01", 2, "TAPE"))?.value).toBe(template().items.filter((row) => row.entity === "TapeEntry").length);
  });

  it("[FL-100] two invocations with the same ticket never run at once", async () => {
    const rig = await readyWorld();
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await rig.mc.connector.counters.claimTicket("g01", "RESETREQ", requestId, new Date(rig.now().getTime() + 60_000).toISOString());
    expect(await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED)).toEqual({ status: "BUSY" });
    expect((await rig.mc.connector.worlds.getMeta("g01", { consistent: true }))?.reset?.phase).toBe("WIPE");
    expect(await coreKeys(rig, "g01")).toHaveLength(coreCount());
  });

  it("[FL-100] expires the pending approvals of the old epoch, once", async () => {
    const rig = await readyWorld();
    await rig.mc.connector.write(rig.mc.connector.complaints.createOp(complaint("g01", { complaintId: "cmp-live-1" })));
    await rig.mc.connector.caseItems.createApproval(approval("g01", { complaintId: "cmp-live-1", approvalId: "apr-live-1" }));
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED);
    const expired = await rig.mc.connector.audit.listByAction("g01", "APPROVAL_EXPIRED");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ epoch: 1, outcome: "EPOCH_CHANGED", refs: { approvalId: "apr-live-1" } });
    expect(await rig.mc.connector.caseItems.listPendingApprovals("g01")).toHaveLength(0);
  });
});

describe("reset_world: hourly resume [FL-100]", () => {
  it("[FL-100] reopens a reset without a heartbeat for 20 minutes and raises WorldResetStuck after three attempts without progress", async () => {
    const rig = await readyWorld();
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await rig.mc.connector.counters.claimTicket("g01", "RESETREQ", requestId, new Date(rig.now().getTime() + 60_000).toISOString());
    expect(await resumeStaleReset(rig.deps, "g01")).toBe("NOT_STALE");
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      rig.advance(21 * 60_000);
      outcomes.push(await resumeStaleReset(rig.deps, "g01"));
    }
    expect(outcomes).toEqual(["RESUMED", "RESUMED", "STUCK"]);
    expect(rig.logs.some((line) => line.includes("WorldResetStuck"))).toBe(true);
    const meta = await rig.mc.connector.worlds.getMeta("g01", { consistent: true });
    expect(meta).toMatchObject({ status: "RESETTING", reset: { attempts: 3 } });
    expect(await rig.mc.connector.counters.getTicket("g01", "RESETREQ", requestId)).toMatchObject({ status: "OPEN", attempts: 3 });
    expect(rig.invoked.filter((event) => event.kind === "WORLD_RESET")).toHaveLength(3);

    // The work it invokes finishes the reset from where it stood.
    expect((await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED)).status).toBe("READY");
    expect(await rig.mc.store.get("Runtime", keys.counter("g01", "EPOCH"))).toMatchObject({ value: 2 });
  });
});
