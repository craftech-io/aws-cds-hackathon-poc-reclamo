// Local flows of the guest self-signup (docs/flows-catalog.md area O; docs/architecture-guests.md §3-§7):
// the real sign-up service and triggers over the fake Cognito of guests/testing (the same memory store),
// and `WorldJanitor` in process with the real `guest` template. The sign-up and its code run as the
// scenario runner's (the QA scope: the only address is the SES simulator's, which a visitor's form
// refuses by design), so no real address is ever written; the life of a `gs-*` world starts from the
// very writes the post-confirmation trigger commits (META `REGISTERED`, the `GUEST` row and the ticket):
// queue → the factory builds it READY → it expires on the real clock → asked again, rebuilt with a new
// epoch. Last, the usage caps of a self-signup world in the in-process pipeline, on its own queue.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type SignupHarness, createSignupHarness, startInput } from "@reclamo/bff/guests/testing/harness";
import { type WorldCreateRequest, provisionOps } from "@reclamo/bff/guests/provision";
import { leadsKeys } from "@reclamo/bff/leads/keys";
import { ulid } from "@reclamo/bff/lib/crypto";
import { createLogger } from "@reclamo/bff/lib/log";
import { worldBuckets } from "@reclamo/bff/worker/caps";
import { UNLIMITED, type WorldsDeps } from "@reclamo/bff/worlds/deps";
import { runJanitor } from "@reclamo/bff/worlds/janitor";
import { GUEST_CAP_KEY, primeQaCapacityOp, readCapacity } from "@reclamo/bff/worlds/meta";
import { requestAndStartReset } from "@reclamo/bff/worlds/reset";
import { memoryTemplateSource } from "@reclamo/bff/worlds/template";
import { WORLD_TEST_KEYS, fakeMemory, fakeObjects } from "@reclamo/bff/worlds/testing";
import { seedPaths } from "../../scripts/seed/lib/constants";
import { createFlowWorld } from "./support/world";

// The guest template is a whole world (some 20,000 items) built block by block in memory.
vi.setConfig({ testTimeout: 120_000 });

const HOUR = 3_600_000;
const GUEST_TEMPLATE: unknown = JSON.parse(readFileSync(join(seedPaths().worlds, "guest.json"), "utf8"));
const TEMPLATE_COUNTER = 122;
const PASSWORD = "Una-Clave-Larga-2026";

/** The scenario runner's scope and its one address (guests/signup.ts `qaSignupEmail`). */
const QA = { runId: "lf1", key: "su1" } as const;
const QA_EMAIL = "success+qa-lf1-su1@simulator.amazonses.com";

/** The sign-up stack and `WorldJanitor` over the same store; every asynchronous invocation runs in process. */
async function guestStack() {
  const harness = await createSignupHarness().ready();
  const janitorQueue: unknown[] = [];
  let ids = 0;
  const memory = fakeMemory();
  const deps: WorldsDeps = {
    store: harness.store,
    connector: harness.connector,
    templates: memoryTemplateSource({ guest: GUEST_TEMPLATE }),
    objects: fakeObjects(),
    schedules: { delete: async () => undefined },
    memory,
    anchors: { request: async () => undefined },
    invoker: { invoke: async (event) => void janitorQueue.push(event) },
    keys: () => WORLD_TEST_KEYS,
    log: createLogger({ sink: () => undefined }),
    now: harness.now,
    sleep: async () => undefined,
    newId: () => `01K7${String((ids += 1)).padStart(22, "0")}`,
  };
  /** Delivers every pending invocation of `WorldJanitor` (the sign-up's and its own), in order. */
  const drain = async () => {
    const results: unknown[] = [];
    for (;;) {
      const fromSignup = harness.invoked.worlds.splice(0) as WorldCreateRequest[];
      const next = [...fromSignup, ...janitorQueue.splice(0)];
      if (next.length === 0) return results;
      for (const event of next) results.push(await runJanitor(deps, event, UNLIMITED));
    }
  };
  return { harness, deps, memory, drain };
}

/** What the post-confirmation trigger commits for a visitor (guests/register.ts): a `gs-*` world queued (or the runner's `qa-*-su*`). */
async function registeredGuestWorld(harness: SignupHarness, sub: string, suffix: string, worldId = `gs-${suffix}`): Promise<string> {
  const ops = provisionOps(harness.ctx);
  const requestId = ulid(harness.now().getTime());
  await harness.connector.transact([ops.worldOp(worldId, worldId.startsWith("gs-") ? "GUEST" : "QA"), ops.staffOp(worldId, sub), ops.ticketOp(worldId, requestId)]);
  await harness.deps.invoker.createWorld({ kind: "WORLD_CREATE", worldId, requestId });
  return worldId;
}

const session = (sub: string, worldId: string, sessionId = "s-1") => ({ sub, worldId, sessionId });

describe("[FL-112] [FL-113] the sign-up and its code", () => {
  it("[FL-112] [FL-113] the form leaves an UNCONFIRMED account and its request, no lead or world; the code registers one lead, one REGISTERED world with its GUEST row and one ticket, even confirmed twice", async () => {
    const { harness } = await guestStack();
    const started = await harness.signup.start(startInput({ email: QA_EMAIL, password: PASSWORD }), "198.51.100.7", QA);
    expect(started.status).toBe("CODE_SENT");
    const signupId = started.status === "CODE_SENT" ? started.signupId : "";
    const user = harness.cognito.user(QA_EMAIL);
    expect(user?.status).toBe("UNCONFIRMED");
    expect(await harness.store.get("Leads", leadsKeys.signup(signupId, QA))).toMatchObject({ status: "CODE_SENT", sub: user?.sub, worldId: "qa-lf1-su1" });
    expect(await harness.store.get("Leads", leadsKeys.lead(user?.sub ?? "", QA))).toBeUndefined();
    expect(harness.invoked.worlds).toEqual([]);

    const code = harness.cognito.lastCode(QA_EMAIL) ?? "";
    expect(await harness.signup.confirm({ signupId, code }, QA)).toMatchObject({ status: "CONFIRMED", worldStatus: "REGISTERED" });
    expect(await harness.signup.confirm({ signupId, code }, QA)).toMatchObject({ status: "CONFIRMED" });
    const sub = user?.sub ?? "";
    expect(harness.cognito.user(QA_EMAIL)?.status).toBe("CONFIRMED");
    expect(await harness.store.get("Leads", leadsKeys.lead(sub, QA))).toMatchObject({ worldId: "qa-lf1-su1" });
    expect(await harness.connector.worlds.getMeta("qa-lf1-su1")).toMatchObject({ status: "REGISTERED", origin: "SIGNUP" });
    expect(await harness.connector.worlds.getStaff("qa-lf1-su1", "stf-qa-lf1-su1")).toMatchObject({ role: "GUEST", active: true });
    expect(harness.invoked.worlds).toEqual([expect.objectContaining({ kind: "WORLD_CREATE", worldId: "qa-lf1-su1" })]);
    expect(harness.invoked.notices).toEqual([]);
  });

  it("[FL-112] refuses the terms unticked, the simulator's address on a visitor's form and a closed sign-up, creating nothing", async () => {
    const { harness } = await guestStack();
    expect(await harness.signup.start(startInput({ email: QA_EMAIL, acceptTerms: false }), "198.51.100.7", QA)).toMatchObject({ status: "CONSENT_REQUIRED" });
    expect(await harness.signup.start(startInput({ email: QA_EMAIL }), "198.51.100.7")).toMatchObject({ status: "INVALID_EMAIL" });
    await harness.setOpen(false);
    expect(await harness.signup.start(startInput({ email: QA_EMAIL }), "198.51.100.7", QA)).toMatchObject({ status: "SIGNUP_UNAVAILABLE" });
    expect(harness.cognito.outbox).toEqual([]);
    expect(harness.invoked.worlds).toEqual([]);
  });
});

describe("[FL-113] [FL-120] the runner's lead: its campaign and its last sign-in", () => {
  it("[FL-113] [FL-120] keeps the visit's UTM on the QALEAD#, and the first guest.status of a session in the READY qa-*-su* world stamps its last sign-in there, never under LEAD#", async () => {
    const { harness, drain } = await guestStack();
    const started = await harness.signup.start(startInput({ email: QA_EMAIL, password: PASSWORD, utm: { source: "qa", medium: "e2e" }, referrer: "https://ads.example.org" }), "198.51.100.7", QA);
    const signupId = started.status === "CODE_SENT" ? started.signupId : "";
    await harness.signup.confirm({ signupId, code: harness.cognito.lastCode(QA_EMAIL) ?? "" }, QA);
    const sub = harness.cognito.user(QA_EMAIL)?.sub ?? "";
    await drain();
    expect((await harness.connector.worlds.getMeta("qa-lf1-su1"))?.status).toBe("READY");

    const status = await harness.guestWorld.status({ sub, worldId: "qa-lf1-su1", sessionId: "lf-session" });
    expect(status.worldStatus).toBe("READY");
    expect(await harness.store.get("Leads", leadsKeys.lead(sub, QA))).toMatchObject({ utm: { source: "qa", medium: "e2e" }, referrer: "https://ads.example.org", lastLoginAtReal: harness.now().toISOString() });
    expect(await harness.store.get("Leads", leadsKeys.lead(sub))).toBeUndefined();
  });
});

describe("[FL-120] [FL-124] a self-signup world: READY, expiry and recreation", () => {
  it("[FL-120] the factory builds the queued gs-* world READY from the guest template, simulated, with the self-signup caps; without a ticket it refuses", async () => {
    const { harness, deps, drain } = await guestStack();
    const sub = "0f6e2c1a-5b7d-4e3f-9a21-c4d8e9f0a1b2";
    const worldId = await registeredGuestWorld(harness, sub, "abcdefghij");
    expect(await harness.guestWorld.status(session(sub, worldId))).toMatchObject({ worldStatus: "REGISTERED" });
    const [built] = await drain();
    expect(built).toMatchObject({ kind: "WORLD_CREATE", result: { status: "READY" } });
    expect(await harness.connector.worlds.getMeta(worldId)).toMatchObject({ status: "READY", epoch: 1, template: "guest", kind: "GUEST", origin: "SIGNUP" });
    expect(await harness.connector.worlds.getSettings(worldId)).toMatchObject({ channelModes: { whatsapp: "simulated" }, turnCaps: { perDay: 60 } });
    expect(await harness.connector.counters.getComplaintCounter(worldId, 1, 2026)).toBe(TEMPLATE_COUNTER);
    expect(await harness.connector.complaints.getByNumber(worldId, "R-2026-000122")).toBeDefined();
    expect(await readCapacity(deps)).toMatchObject({ active: 1, creating: 0 });
    expect(await harness.guestWorld.status(session(sub, worldId))).toMatchObject({ worldStatus: "READY", queuePosition: 0, usage: { turnsToday: 0, turnsPerDay: 60, limitReached: false } });
    expect(await runJanitor(deps, { kind: "WORLD_CREATE", worldId: "gs-zzzzzzzzzz", requestId: ulid(harness.now().getTime()) }, UNLIMITED)).toMatchObject({ result: { status: "MISSING" } });
  });

  it("[FL-124] six real hours after READY without a sign-in it expires (META, SETTINGS and the GUEST row stay, its memory is purged, its place freed); asked again it is rebuilt with epoch + 1", async () => {
    const { harness, deps, memory, drain } = await guestStack();
    const sub = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const worldId = await registeredGuestWorld(harness, sub, "bcdefghijk");
    await drain();
    memory.add(`w-${worldId}-cus-0001-e1`, 3, 2);
    harness.advance(6 * HOUR + 60_000);
    await runJanitor(deps, { kind: "PROVISION_PASS" }, UNLIMITED);
    await drain();
    const expired = await harness.connector.worlds.getMeta(worldId);
    expect(expired).toMatchObject({ status: "EXPIRED", epoch: 2 });
    expect(await harness.connector.worlds.getSettings(worldId)).toBeDefined();
    expect(await harness.connector.worlds.getStaff(worldId, `stf-${worldId}`)).toMatchObject({ active: true });
    const actor = memory.actors.get(`w-${worldId}-cus-0001-e1`);
    expect(actor?.records.size).toBe(0);
    expect([...(actor?.sessions.values() ?? [])].every((events) => events.size === 0)).toBe(true);
    expect(await readCapacity(deps)).toMatchObject({ active: 0 });
    expect(await harness.guestWorld.status(session(sub, worldId))).toMatchObject({ worldStatus: "EXPIRED" });

    expect(await harness.guestWorld.requestWorld(session(sub, worldId))).toEqual({ status: "REGISTERED" });
    await drain();
    const rebuilt = await harness.connector.worlds.getMeta(worldId);
    // The expiry already opened the next epoch; the rebuilt world is the clean template in it.
    expect(rebuilt).toMatchObject({ status: "READY", epoch: 2 });
    expect(await harness.connector.counters.getComplaintCounter(worldId, rebuilt?.epoch ?? 0, 2026)).toBe(TEMPLATE_COUNTER);
  });
});

describe("[FL-117] the 40 places taken: the queue", () => {
  it("[FL-117] a confirmed sign-up with the places taken stays REGISTERED in the queue with its ticket open; a freed place lets the provisioning pass build it", async () => {
    const { harness, deps, drain } = await guestStack();
    await harness.store.write({ kind: "put", table: "Runtime", item: { ...GUEST_CAP_KEY, entity: "GuestCapacity", active: 40, creating: 0, version: 1, updatedAt: harness.now().toISOString() } });
    const sub = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    const worldId = await registeredGuestWorld(harness, sub, "cdefghijkl");
    const [queued] = await drain();
    expect(queued).toMatchObject({ kind: "WORLD_CREATE", result: { status: "QUEUED" } });
    expect(await harness.connector.worlds.getMeta(worldId)).toMatchObject({ status: "REGISTERED" });
    expect(await readCapacity(deps)).toMatchObject({ active: 40, creating: 0 });
    await runJanitor(deps, { kind: "PROVISION_PASS" }, UNLIMITED);
    expect(await harness.guestWorld.status(session(sub, worldId))).toMatchObject({ worldStatus: "REGISTERED", queuePosition: expect.any(Number) });

    await harness.store.write({ kind: "put", table: "Runtime", item: { ...GUEST_CAP_KEY, entity: "GuestCapacity", active: 39, creating: 0, version: 2, updatedAt: harness.now().toISOString() } });
    await runJanitor(deps, { kind: "PROVISION_PASS" }, UNLIMITED);
    await drain();
    expect(await harness.connector.worlds.getMeta(worldId)).toMatchObject({ status: "READY" });
    expect((await readCapacity(deps)).active).toBeLessThanOrEqual(40);
  });
});

describe("[FL-117] the runner's sign-up worlds: a queue and a capacity of their own", () => {
  it("[FL-117] with GUESTCAP#QA primed to 1, su2 stays REGISTERED behind su1; su1 expired, the pass builds su2; the visitors' GUESTCAP#ACTIVE is never touched", async () => {
    const { harness, deps, drain } = await guestStack();
    const su1 = await registeredGuestWorld(harness, "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f", "", "qa-lf1-su1");
    expect(await drain()).toEqual([expect.objectContaining({ result: { status: "READY" } })]);
    await deps.store.write(primeQaCapacityOp(deps, 1, QA.runId));
    const su2 = await registeredGuestWorld(harness, "4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a", "", "qa-lf1-su2");
    expect(await drain()).toEqual([expect.objectContaining({ result: { status: "QUEUED" } })]);
    expect(await harness.connector.worlds.getMeta(su2)).toMatchObject({ status: "REGISTERED" });
    expect(await readCapacity(deps, "QA")).toMatchObject({ active: 1, creating: 0, prime: { limit: 1, runId: QA.runId } });

    await requestAndStartReset(deps, { worldId: su1, actor: "QA", kind: "EXPIRE", reason: "QA_EXPIRE_NOW" });
    await drain();
    expect(await harness.connector.worlds.getMeta(su1)).toMatchObject({ status: "EXPIRED" });
    await runJanitor(deps, { kind: "PROVISION_PASS" }, UNLIMITED);
    await drain();
    expect(await harness.connector.worlds.getMeta(su2)).toMatchObject({ status: "READY" });
    expect(await readCapacity(deps, "QA")).toMatchObject({ active: 1, creating: 0 });
    expect(await harness.store.get("Runtime", GUEST_CAP_KEY)).toBeUndefined();
  });
});

describe("[FL-125] the usage caps of a self-signup world", () => {
  it("[FL-125] at the day's turn cap the number and the acknowledgement still go out by rules, but no G1 and no Harness: a person takes it; the turns run on the sign-up queue, apart from an invited world's", async () => {
    const worldId = "gs-abcdefghij";
    const world = await createFlowWorld({ worlds: [{ worldId, template: "guest" }, { worldId: "g07", template: "guest" }], plans: () => [{ tool: "send_whatsapp", input: { kind: "REPLY", text: "Lo reviso." } }] });
    const settings = await world.connector.worlds.getSettings(worldId);
    expect(settings).toMatchObject({ channelModes: { whatsapp: "simulated" }, turnCaps: { perDay: 60 } });
    const day = worldBuckets(worldId, 1, settings as never, world.realNow()).find((bucket) => bucket.window === "DAY");
    await world.connector.caps.set({ kind: "TURNCAP", worldId, window: "DAY", at: world.realNow() }, day?.limit ?? 60);

    // The persona's own script: a complaint the rules recognize, so the number never needs the model.
    await world.phone("cus-0001", { type: "text", text: "Pagué la cuota 4 en la Red de cobro Norte el martes a la tarde y me sigue figurando atrasada" }, { worldId });
    expect(world.harness.turns).toHaveLength(0);
    expect(world.guardrails.g1.texts).toHaveLength(0);
    const complaint = await world.connector.complaints.getByNumber(worldId, "R-2026-000123");
    expect(complaint?.status).toBe("HUMAN_REVIEW");
    const out = (await world.connector.conversations.listMessages(worldId, "cus-0001")).filter((message) => message.direction === "OUT" && (message.createdAt ?? "") > "2026-10-07T13:10:00.000Z");
    expect(out.map((message) => message.kind)).toEqual(expect.arrayContaining(["COMPLAINT_ACK", "HANDOFF_NOTICE"]));
    expect(world.queues.sent.map((sent) => sent.QueueUrl).filter((url) => url?.includes("SignupCustomerEvents"))).not.toHaveLength(0);
    expect(world.queues.sent.map((sent) => sent.QueueUrl).filter((url) => url?.endsWith("-CustomerEvents.fifo"))).toHaveLength(0);

    await world.phone("cus-0001", { type: "text", text: "Hola" }, { worldId: "g07" });
    expect(world.harness.turns).toHaveLength(1);
    expect(world.queues.sent.map((sent) => sent.QueueUrl).filter((url) => url?.endsWith("-CustomerEvents.fifo"))).toHaveLength(1);
  });
});
