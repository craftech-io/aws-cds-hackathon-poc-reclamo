import { describe, expect, it } from "vitest";
import type { SnsRecord } from "../channels/whatsapp/payloads";
import { qaSimulatedWamid, verifySimulatedRecord } from "../channels/whatsapp/sim-envelope";
import { TEST_SIM_KEYS } from "../channels/whatsapp/testing";
import { keys } from "../connector/keys";
import { TEST_NOW, email, testConnector, worldMeta } from "../connector/testing";
import { qaSignupEmail } from "../guests/signup";
import { probeLead } from "../leads/probe";
import { leadsRepo } from "../leads/repo";
import type { SignupService } from "../guests/signup";
import { START_SIM, timersKit } from "../timers/testing";
import { takeForcedTurn } from "../turns/forced";
import { GUEST_CAP_KEY, activeLimitFor, readCapacity } from "../worlds/meta";
import { markIdOf } from "./contract";
import { QA_WORLD, RUN, fakeJwt, key, qaKit } from "./testing";

const MINUTE = 60_000;

async function readyWorld(kit: { connector: ReturnType<typeof testConnector>["connector"] }, worldId = QA_WORLD): Promise<void> {
  await kit.connector.worlds.register(worldMeta(worldId, { status: "READY" }));
}

/** A world with one cloned persona `a` (its phone and customer remembered as world.create leaves them). */
async function personaWorld(mc: ReturnType<typeof testConnector>): Promise<void> {
  await readyWorld(mc);
  await mc.connector.claims.claimOnce(QA_WORLD, "QAPERSONA", "a", { customerId: `cus-${QA_WORLD}-a`, model: "C01", phoneE164: "+5491100009123" });
}

describe("auth.session", () => {
  it("creates the user of a role once, binds its staff row and signs in with a new password on every call", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    const kit = qaKit({ mc });
    const first = await kit.driver({ action: "auth.session", idempotencyKey: key(1), input: { worldId: QA_WORLD, sessionKey: "op", role: "OPERATOR" } });
    const firstPassword = kit.cognito.users.get(`${QA_WORLD}-operator`)?.password;
    const second = await kit.driver({ action: "auth.session", idempotencyKey: key(1), input: { worldId: QA_WORLD, sessionKey: "op", role: "OPERATOR", flow: "SRP" } });
    expect(first).toMatchObject({ ok: true, replayed: false, result: { idToken: expect.any(String), accessToken: expect.any(String), exp: expect.any(Number), authTime: expect.any(Number) } });
    expect(second).toMatchObject({ ok: true, replayed: false });
    expect(JSON.stringify(first)).not.toContain(firstPassword ?? "never");
    expect(kit.cognito.users.size).toBe(1);
    expect(kit.cognito.users.get(`${QA_WORLD}-operator`)?.password).not.toBe(firstPassword);
    expect(kit.cognito.logins).toEqual([
      { flow: "ADMIN", username: `${QA_WORLD}-operator` },
      { flow: "SRP", username: `${QA_WORLD}-operator` },
    ]);
    const staff = await mc.connector.worlds.getStaff(QA_WORLD, "stf-qa-operator");
    expect(staff).toMatchObject({ role: "OPERATOR", active: true, cognitoSubKey: `SUB#${kit.cognito.users.get(`${QA_WORLD}-operator`)?.sub}` });
  });

  it("with probeCognito reports what the pool answered to the user's own self-service calls", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    const kit = qaKit({ mc });
    const answer = await kit.driver({ action: "auth.session", idempotencyKey: key(2), input: { worldId: QA_WORLD, sessionKey: "op", role: "SUPERVISOR", probeCognito: true } });
    expect(answer).toMatchObject({ ok: true, result: { probe: { updateAttributes: "NotAuthorizedException", changePassword: "NotAuthorizedException", deleteUser: "NotAuthorizedException" } } });
  });
});

describe("console.*", () => {
  it("[FL-099] runs the real procedures as the server-built principal, with their role guards", async () => {
    const timers = timersKit();
    await timers.seedWorld(QA_WORLD, START_SIM);
    await readyWorld(timers);
    const kit = qaKit({ mc: { connector: timers.connector, store: timers.store }, timers: () => timers.deps });
    expect(await kit.driver({ action: "console", idempotencyKey: key(3), input: { worldId: QA_WORLD, procedure: "clock.get", role: "COMPLIANCE" } })).toMatchObject({
      ok: true,
      result: { worldId: QA_WORLD, mode: "PAUSED", simNow: START_SIM },
    });
    expect(await kit.driver({ action: "console", idempotencyKey: key(4), input: { worldId: QA_WORLD, procedure: "clock.advance", role: "COMPLIANCE", input: { minutes: 5 } } })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await kit.driver({ action: "clock.advance", idempotencyKey: key(5), input: { worldId: QA_WORLD, minutes: 30 } })).toMatchObject({ ok: true, result: { simNow: "2026-10-07T10:40:00-03:00" } });
    expect(await kit.driver({ action: "console", idempotencyKey: key(6), input: { worldId: QA_WORLD, procedure: "clock.nothing", role: "OPERATOR" } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("console.clock.reset writes the request without the console's interval and hands it to WorldJanitor", async () => {
    const timers = timersKit();
    await timers.seedWorld(QA_WORLD, START_SIM);
    await readyWorld(timers);
    const kit = qaKit({ mc: { connector: timers.connector, store: timers.store } });
    const answer = await kit.driver({ action: "console", idempotencyKey: key(7), input: { worldId: QA_WORLD, procedure: "clock.reset", role: "OPERATOR" } });
    expect(answer).toMatchObject({ ok: true, result: { status: "RESETTING", requestId: expect.any(String) } });
    expect(kit.recorded.janitor).toEqual([{ kind: "WORLD_RESET", worldId: QA_WORLD, requestId: (answer as { result: { requestId: string } }).result.requestId }]);
  });
});

describe("clock.unfreeze and clock.freeze", () => {
  it("moves a paused clock to the timer minus its lead, runs it and creates the schedules in one call", async () => {
    const timers = timersKit();
    await timers.seedWorld(QA_WORLD, START_SIM);
    const dueAtSim = new Date(Date.parse(START_SIM) + 2 * 24 * 60 * MINUTE).toISOString();
    await timers.putTimers(QA_WORLD, { kind: "FOLLOW_UP", timerId: "f1", dueAtSim, ownerKey: "CMP#cmp-0001", payload: { complaintId: "cmp-0001" } });
    const kit = qaKit({ mc: { connector: timers.connector, store: timers.store }, timers: () => timers.deps });
    const timerKey = keys.timerKey(QA_WORLD, "FOLLOW_UP", "f1");
    const answer = await kit.driver({ action: "clock.unfreeze", idempotencyKey: key(8), input: { worldId: QA_WORLD, timerKey, leadSec: 120, rate: 1 } });
    expect(answer).toMatchObject({ ok: true, result: { timerKey, dueAtSim, dueAtReal: new Date(TEST_NOW.getTime() + 2 * MINUTE).toISOString() } });
    expect(await timers.connector.runtime.getClock(QA_WORLD)).toMatchObject({ mode: "RUNNING", rate: 1 });
    expect([...timers.scheduler.live.values()].map((spec) => spec.input.timerKey)).toContain(timerKey);
    await kit.driver({ action: "clock.freeze", idempotencyKey: key(9), input: { worldId: QA_WORLD } });
    expect(await timers.connector.runtime.getClock(QA_WORLD)).toMatchObject({ mode: "PAUSED" });
    expect(timers.scheduler.live.size).toBe(0);
  });
});

describe("conv.settleProbe", () => {
  it("answers settled for a quiet world and names what a busy one waits for", async () => {
    const timers = timersKit();
    await timers.seedWorld(QA_WORLD, START_SIM);
    const kit = qaKit({ mc: { connector: timers.connector, store: timers.store } });
    expect(await kit.driver({ action: "conv.settleProbe", idempotencyKey: key(10), input: { worldId: QA_WORLD } })).toMatchObject({ ok: true, result: { settled: true } });
    await timers.connector.write(timers.connector.runtime.addInFlightOp(QA_WORLD, `cus-0001#evt-1~${TEST_NOW.getTime()}`));
    const busy = await kit.driver({ action: "conv.settleProbe", idempotencyKey: key(10), input: { worldId: QA_WORLD, customerId: "cus-0001" } });
    expect(busy).toMatchObject({ ok: true, result: { settled: false, pending: [{ kind: "EVENT", detail: "evt-1" }] } });
    expect(await kit.driver({ action: "conv.settleProbe", idempotencyKey: key(10), input: { worldId: QA_WORLD, customerId: "cus-0002" } })).toMatchObject({ result: { settled: true } });
  });
});

describe("wa.inbound", () => {
  it("[FL-099] signs the simulator's record with the QA key; the wamid derives from the step's key", async () => {
    const mc = testConnector();
    await personaWorld(mc);
    const kit = qaKit({ mc });
    const answer = await kit.driver({ action: "wa.inbound", idempotencyKey: key(11), input: { worldId: QA_WORLD, persona: "a", content: { type: "text", text: "No se me acreditó el pago" } } });
    expect(answer).toMatchObject({ ok: true, result: { wamid: qaSimulatedWamid(key(11)), customerId: `cus-${QA_WORLD}-a`, accepted: true } });
    const record = kit.recorded.delivered[0]?.Records[0] as SnsRecord;
    expect(verifySimulatedRecord(record, TEST_SIM_KEYS, TEST_NOW)).toEqual({ ok: true, kid: "qa", worldId: QA_WORLD });
    expect(record.Sns.Message).toContain("549110000912");
  });

  it("an image is a seed receipt or a variant built on the server, never bytes in the payload", async () => {
    const mc = testConnector();
    await personaWorld(mc);
    const kit = qaKit({ mc });
    await kit.driver({ action: "wa.inbound", idempotencyKey: key(12), input: { worldId: QA_WORLD, persona: "a", content: { type: "receipt", variant: "legible", personaModel: "C01" } } });
    await kit.driver({ action: "wa.inbound", idempotencyKey: key(13), input: { worldId: QA_WORLD, persona: "a", content: { type: "serverImage", variant: "oversize-7mb" } } });
    expect(kit.recorded.media).toEqual([{ key: expect.stringMatching(new RegExp(`^qa/[0-9-]+/${QA_WORLD}/up/up-[0-9a-f]{26}/0\\.png$`)), bytes: 7 * 1024 * 1024, contentType: "image/png" }]);
    expect(JSON.stringify(kit.recorded.delivered).length).toBeLessThan(20_000);
  });

  it("[FL-106] sends an eval image by its seed key, a PDF as a document, and a redelivery with the earlier wamid", async () => {
    const mc = testConnector();
    await personaWorld(mc);
    const kit = qaKit({ mc });
    const file = "receipts/tampered-chunk/ev-tampered-chunk-01.png";
    await kit.driver({ action: "wa.inbound", idempotencyKey: key(16), input: { worldId: QA_WORLD, persona: "a", content: { type: "seedFile", file } } });
    const simMediaId = /"id":"(SIM[0-9a-f]{32})"/.exec(kit.recorded.delivered[0]?.Records[0]?.Sns.Message.replaceAll("\\", "") ?? "")?.[1] ?? "";
    expect(await mc.connector.claims.getSimMedia(QA_WORLD, simMediaId)).toMatchObject({ s3Key: file });
    await kit.driver({ action: "wa.inbound", idempotencyKey: key(17), input: { worldId: QA_WORLD, persona: "a", content: { type: "document" } } });
    expect(kit.recorded.delivered[1]?.Records[0]?.Sns.Message).toContain("application/pdf");
    expect(kit.recorded.media).toEqual([]);
    const again = await kit.driver({ action: "wa.inbound", idempotencyKey: key(18), input: { worldId: QA_WORLD, persona: "a", content: { type: "text", text: "hola" }, redeliveryOf: qaSimulatedWamid(key(16)) } });
    expect(again).toMatchObject({ ok: true, result: { wamid: qaSimulatedWamid(key(16)) } });
    expect(kit.recorded.delivered[2]?.Records[0]?.Sns.Message).toContain(qaSimulatedWamid(key(16)));
    const live = await kit.driver({ action: "wa.inbound", idempotencyKey: key(19), input: { worldId: QA_WORLD, persona: "a", content: { type: "text", text: "hola" }, redeliveryOf: "wamid.HBgLNTQ5MTE" } });
    expect(live).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("names a persona of qamin by its model", async () => {
    const mc = testConnector();
    await readyWorld(mc, "qamin");
    const kit = qaKit({ mc });
    expect(await kit.driver({ action: "wa.inbound", idempotencyKey: key(14), input: { worldId: "qamin", persona: "C07", content: { type: "text", text: "hola" } } })).toMatchObject({ ok: true, result: { customerId: "cus-0007" } });
    expect(await kit.driver({ action: "wa.inbound", idempotencyKey: key(15), input: { worldId: QA_WORLD, persona: "C07", content: { type: "text", text: "hola" } } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });
});

describe("caps, kill switch and forced turns", () => {
  it("primes a world's turn cap, a sender's rate and the QA-only guest capacity, never the visitors' one", async () => {
    const mc = testConnector();
    await personaWorld(mc);
    const kit = qaKit({ mc });
    await kit.driver({ action: "caps.prime", idempotencyKey: key(16), input: { worldId: QA_WORLD, bucket: "TURNCAP", value: 59 } });
    expect(await mc.connector.caps.peek({ kind: "TURNCAP", worldId: QA_WORLD, window: "DAY", at: TEST_NOW })).toBe(59);
    await kit.driver({ action: "caps.prime", idempotencyKey: key(17), input: { worldId: QA_WORLD, bucket: "RATE", value: 9, persona: "a" } });
    expect(await mc.connector.caps.peek({ kind: "RATE", worldId: QA_WORLD, phoneHash: "hash-9123", at: TEST_NOW })).toBe(9);
    expect(await kit.driver({ action: "caps.prime", idempotencyKey: key(18), input: { bucket: "GUESTCAP_QA", value: 1 } })).toMatchObject({ ok: true, result: { bucket: "GUESTCAP_QA", value: 1 } });
    const qa = await readCapacity({ store: mc.store }, "QA");
    expect(qa).toMatchObject({ activeLimit: 8, prime: { limit: 1, runId: RUN } });
    // Only this run's sign-up worlds see it, and only for an hour.
    expect(activeLimitFor(qa, `qa-${RUN}-su2`, TEST_NOW)).toBe(1);
    expect(activeLimitFor(qa, "qa-999-1-su2", TEST_NOW)).toBe(8);
    expect(activeLimitFor(qa, `qa-${RUN}-su2`, new Date(TEST_NOW.getTime() + 61 * 60_000))).toBe(8);
    expect(await mc.store.get("Runtime", GUEST_CAP_KEY)).toBeUndefined();
    expect(await readCapacity({ store: mc.store })).toMatchObject({ activeLimit: 40 });
  });

  it("[FL-109] turns the agent off and on for its own world only", async () => {
    const mc = testConnector();
    const kit = qaKit({ mc });
    await kit.driver({ action: "kill.setWorld", idempotencyKey: key(19), input: { worldId: QA_WORLD, on: true } });
    expect(await mc.connector.runtime.isAgentKilled(QA_WORLD)).toBe(true);
    await kit.driver({ action: "kill.setWorld", idempotencyKey: key(20), input: { worldId: QA_WORLD, on: false } });
    expect(await mc.connector.runtime.isAgentKilled(QA_WORLD)).toBe(false);
  });

  it("[FL-107] leaves the order of the next turn for the worker to take once", async () => {
    const mc = testConnector();
    const kit = qaKit({ mc });
    await kit.driver({ action: "turn.forceSilence", idempotencyKey: key(21), input: { worldId: QA_WORLD, customerId: "cus-0001", mode: "NO_OUTBOUND" } });
    expect(await takeForcedTurn(mc.connector, QA_WORLD, "cus-0001")).toBe("NO_OUTBOUND");
    expect(await takeForcedTurn(mc.connector, QA_WORLD, "cus-0001")).toBeUndefined();
  });
});

describe("the runner's self-signups", () => {
  it("[FL-112] [FL-113] signs up only the run's own simulator address, then confirms it through the admin path", async () => {
    const mc = testConnector();
    const calls: unknown[] = [];
    const service = {
      availability: async () => ({ status: "open" }),
      start: async (input: unknown, ip: string, qa: unknown) => (calls.push({ op: "start", input, ip, qa }), { status: "CODE_SENT", signupId: "a".repeat(26) }),
      confirm: async (input: unknown, qa: unknown) => (calls.push({ op: "confirm", input, qa }), { status: "CONFIRMED", worldStatus: "REGISTERED", email: "never-returned" }),
      resend: async () => ({ status: "CODE_SENT" }),
    } as unknown as SignupService;
    const kit = qaKit({ mc, overrides: { signup: () => service } });
    const utm = { source: "qa", medium: "e2e", campaign: "surfaces" };
    const started = await kit.driver({ action: "guest.signup", idempotencyKey: key(22), input: { runId: RUN, key: "su1", locale: "es", acceptContact: true, utm, referrer: "https://ads.example.org" } });
    expect(started).toMatchObject({ ok: true, result: { status: "CODE_SENT", worldId: `qa-${RUN}-su1` } });
    expect(calls[0]).toMatchObject({ input: { email: qaSignupEmail({ runId: RUN, key: "su1" }), acceptTerms: true, acceptContact: true, locale: "es", utm, referrer: "https://ads.example.org" }, qa: { runId: RUN, key: "su1" } });
    // The campaign is checked as the public form's: a link in it, or a path in the referrer, is INVALID.
    for (const [index, input] of [{ utm: { source: "https://phish.example" } }, { utm: { source: "x".repeat(101) } }, { referrer: "https://ads.example.org/path" }].entries()) {
      expect(await kit.driver({ action: "guest.signup", idempotencyKey: key(22, "sc01", `bad${index}`), input: { runId: RUN, key: "su2", locale: "es", ...input } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    const confirmed = await kit.driver({ action: "guest.confirm", idempotencyKey: key(23), input: { runId: RUN, key: "su1", signupId: "a".repeat(26) } });
    expect(confirmed).toEqual({ ok: true, replayed: false, result: { status: "CONFIRMED", worldStatus: "REGISTERED", worldId: `qa-${RUN}-su1` } });
    expect(kit.cognito.confirmed).toEqual([{ username: qaSignupEmail({ runId: RUN, key: "su1" }), clientMetadata: { signupId: "a".repeat(26) } }]);
  });

  it("[FL-126] guest.lead reads the run's QALEAD# through its GUEST row: campaign, consents and instants, never the address", async () => {
    const mc = testConnector();
    const qa = { runId: RUN, key: "su1" };
    const worldId = `qa-${RUN}-su1`;
    await mc.connector.worlds.putStaff({ worldId, staffId: `stf-${worldId}`, role: "GUEST", displayName: "Invitado", cognitoSubKey: "SUB#sub-qa-1", active: true });
    const lead = { ...probeLead(RUN, TEST_NOW), sub: "sub-qa-1", worldId, qa, utm: { source: "qa" }, lastLoginAtReal: TEST_NOW.toISOString() };
    await mc.store.write(leadsRepo({ store: mc.store, now: () => TEST_NOW }).putLeadOp(lead));
    const kit = qaKit({ mc });
    const answer = await kit.driver({ action: "guest.lead", idempotencyKey: key(33), input: qa });
    expect(answer).toMatchObject({ ok: true, result: { exists: true, worldId, utm: { source: "qa" }, consents: { contactAccepted: true }, lastLoginAtReal: TEST_NOW.toISOString(), notified: false } });
    expect(JSON.stringify(answer)).not.toMatch(/simulator\.amazonses|sub-qa-1/);
    expect(await kit.driver({ action: "guest.lead", idempotencyKey: key(34), input: { runId: RUN, key: "su2" } })).toMatchObject({ ok: true, result: { exists: false } });
  });

  it("[FL-113] guest.session signs the account in with a new password and reports its world status", async () => {
    const mc = testConnector();
    const kit = qaKit({ mc });
    kit.cognito.users.set(qaSignupEmail({ runId: RUN, key: "su1" }), { sub: "s", worldId: `qa-${RUN}-su1`, group: "" });
    const answer = await kit.driver({ action: "guest.session", idempotencyKey: key(24), input: { runId: RUN, key: "su1" } });
    expect(answer).toMatchObject({ ok: true, result: { worldStatus: "READY", idToken: expect.any(String) } });
    expect(kit.cognito.logins).toEqual([{ flow: "SRP", username: qaSignupEmail({ runId: RUN, key: "su1" }) }]);
  });
});

describe("probes", () => {
  it("guardrail.probe, probe.edge, gate.probe without the lexicons and mail.outcome", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    await mc.connector.emails.put(email(QA_WORLD, { mailId: "mail-1", events: [{ type: "SEND", atReal: TEST_NOW.toISOString() }, { type: "DELIVERY", atReal: TEST_NOW.toISOString() }] }));
    const kit = qaKit({ mc });
    expect(await kit.driver({ action: "guardrail.probe", idempotencyKey: key(25), input: {} })).toMatchObject({ ok: true, result: { intervened: true } });
    expect(await kit.driver({ action: "probe.edge", idempotencyKey: key(26), input: {} })).toMatchObject({ ok: true, result: { refused: true } });
    expect(await kit.driver({ action: "gate.probe", idempotencyKey: key(27), input: { worldId: QA_WORLD, customerId: "cus-0001", kind: "REPLY", text: "Pagá hoy la cuota", bypassLexicon: true } })).toMatchObject({
      ok: true,
      result: { layer: "G2" },
    });
    expect(await kit.driver({ action: "mail.outcome", idempotencyKey: key(28), input: { worldId: QA_WORLD, mailId: "mail-1" } })).toMatchObject({ ok: true, result: { status: "DELIVERED" } });
    expect(await kit.driver({ action: "mail.outcome", idempotencyKey: key(29), input: { worldId: QA_WORLD, mailId: "mail-2" } })).toMatchObject({ ok: true, result: { status: "NOT_FOUND" } });
  });

  it("[FL-126] notice.probe sends the real notice of a synthetic QA lead to the SES mailbox simulator only, and audits it apart", async () => {
    const mc = testConnector();
    const kit = qaKit({ mc });
    expect(await kit.driver({ action: "notice.probe", idempotencyKey: key(31), input: {} })).toEqual({ ok: true, replayed: false, result: { outcome: "SENT", recipient: "SES_MAILBOX_SIMULATOR" } });
    expect(kit.recorded.notices.map((notice) => [notice.to, notice.subject])).toEqual([["success@simulator.amazonses.com", "Nuevo lead · Reclamo en regla"]]);
    expect(kit.recorded.notices[0]?.text).toContain(`Email: ${qaSignupEmail({ runId: RUN, key: "su0" })}`);
    const month = TEST_NOW.toISOString().slice(0, 7);
    expect((await mc.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#QA#${month}` })).items).toEqual([expect.objectContaining({ action: "LEAD_NOTICE_PROBE", outcome: "SENT" })]);
    expect((await mc.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${month}` })).items).toEqual([]);
    // A probe touches no world and is never remembered: a retry sends again, to the simulator only.
    expect(await kit.driver({ action: "notice.probe", idempotencyKey: key(31), input: {} })).toMatchObject({ ok: true, replayed: false });
    expect(kit.recorded.notices.map((notice) => notice.to)).toEqual(["success@simulator.amazonses.com", "success@simulator.amazonses.com"]);
    expect(await kit.driver({ action: "notice.probe", idempotencyKey: key(32), input: { to: "someone@example.org" } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("never remembers a probe: the mark of a key exists only for changing actions", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    const kit = qaKit({ mc });
    await kit.driver({ action: "snapshot", idempotencyKey: key(30), input: { worldId: QA_WORLD } });
    expect(await mc.connector.claims.getIdempotency(QA_WORLD, "QA", markIdOf(key(30)))).toBeUndefined();
    expect(fakeJwt({ a: 1 }).split(".")).toHaveLength(3);
  });
});
