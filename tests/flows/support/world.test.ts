// The in-process world of the local flows (docs/test-plan.md §3): the seed as the world factory leaves
// it, every entry point of the stage wired to the real modules, and the scripted Harness reaching the
// targets only through the Gateway with the stage's own Cedar statements.
import { describe, expect, it, vi } from "vitest";
import { GENESIS_HASH } from "@reclamo/bff/complaints/register";
import { loadChain, verifyRegisterChain } from "@reclamo/bff/complaints/register-verify";
import { fixture, liveEvent } from "@reclamo/bff/channels/whatsapp/testing";
import { buildSimulatedEvent } from "@reclamo/bff/channels/whatsapp/sim-envelope";
import { personaNumber } from "@reclamo/bff/outbound/directory";
import { createLogger } from "@reclamo/bff/lib/log";
import { phoneHashOf, LOCAL_KEYS } from "./keys";
import { createTokenIssuer, newSigningKey } from "./issuer";
import { templateFile } from "./seed-world";
import { answerChallenge, askChallenge, repliesToChallenge, verifyWritten } from "./challenge";
import { outputOf } from "./scripted-harness";
import { createFlowWorld } from "./world";

// Each test seeds a whole demo world (some 20,000 items): generous on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const C01 = "cus-0001";
/** A text of the classifier's evaluation set: a payment that does not show (FL-010). */
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const quiet = createLogger({ sink: () => undefined });


describe("the seed in memory", () => {
  it("loads the demo template as the world factory leaves it: ready, its settings, the paused clock and the console's staff", async () => {
    const world = await createFlowWorld();
    const template = templateFile("demo");
    expect(world.worldId).toBe("demo");
    expect((await world.connector.worlds.getMeta("demo"))?.status).toBe("READY");
    expect((await world.connector.worlds.getSettings("demo"))?.channelModes.whatsapp).toBe("simulated");
    expect((await world.simNow()).toISOString()).toBe(new Date(template.startAtSim).toISOString());
    expect((await world.connector.worlds.listStaff("demo")).map((row) => row.role).sort()).toEqual(["COMPLIANCE", "OPERATOR", "SUPERVISOR"]);
    expect(await world.connector.complaints.getByNumber("demo", "R-2026-000122")).toBeDefined();
    expect(await world.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(122);
  });

  it("resolves a persona's phone through the core with the local PhoneHashKey and serves the published settlement files", async () => {
    const world = await createFlowWorld();
    const core = world.mocks.core("InboundWhatsApp");
    const phoneHash = await phoneHashOf(personaNumber(C01) ?? "");
    await expect(core.call("getCustomerByPhone", { worldId: "demo", simNow: "2026-10-07T10:10:00-03:00" }, { params: { phoneHash } })).resolves.toEqual({ customerId: C01 });
    const published = templateFile("demo").settlements.filter((settlement) => settlement.seedPath !== undefined);
    expect(published.length).toBeGreaterThan(0);
    for (const settlement of published) expect(world.s3.get("Settlements", `W/demo/${settlement.seedPath}`)?.bytes.byteLength).toBeGreaterThan(0);
  });

  it("recomputes the three chains with the local chain key, anchored, and verifies them like the register's export", async () => {
    const world = await createFlowWorld();
    const deps = world.stage.complaints(quiet);
    const register = await loadChain(deps, "demo", 1, "REG");
    expect(register).toHaveLength(templateFile("demo").counts.RegisterEntry ?? -1);
    expect(register[0]?.prevHash).toBe(GENESIS_HASH);
    for (const chain of ["REG", "RRI", "TAPE"] as const) {
      expect((await verifyRegisterChain(deps, world.stage.anchorLog, { worldId: "demo", epoch: 1, chain })).result, chain).toBe("ok");
    }
  });
});

describe("the entry points of the stage", () => {
  it("InboundWhatsApp: the simulator's signed envelope files the complaint with its number and the worker runs the turn", async () => {
    const world = await createFlowWorld({ plans: [[{ tool: "send_whatsapp", input: { kind: "REPLY", text: "Ya registré tu reclamo y lo estoy revisando." } }]] });
    const summary = await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "INTAKE", intake: "ACKNOWLEDGED", customerId: C01 });
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(complaint).toMatchObject({ customerId: C01, type: "PAYMENT_NOT_REFLECTED" });
    const out = (await world.connector.conversations.listMessages("demo", C01)).filter((message) => message.direction === "OUT");
    expect(out.find((message) => message.kind === "COMPLAINT_ACK")).toMatchObject({ status: "DELIVERED", flags: { disclosure: true } });
    const [turn] = world.harness.turns;
    expect(turn?.event.type).toBe("CUSTOMER_MESSAGE");
    expect(turn?.inbound).toBe(PAYMENT_NOT_REFLECTED);
    expect(Object.keys(turn?.preloaded ?? {})).toContain("identify_customer");
    expect(outputOf(world.harness.results[0])).toMatchObject({ decision: "ALLOWED" });
    const tape = await world.connector.chains.listTapeByMessage(String(outputOf(world.harness.results[0]).messageId));
    expect(tape.map((entry) => entry.decision)).toEqual(expect.arrayContaining(["ALLOWED"]));
    expect(world.queues.waiting()).toHaveLength(0);
    expect(world.queues.deadLetters).toEqual([]);
  });

  it("InboundWhatsApp: an envelope signed with another key, or a live record for a world that is not live, changes nothing", async () => {
    const world = await createFlowWorld();
    const forged = buildSimulatedEvent("not-the-console-key-of-this-world-0123456789", { kid: "console", worldId: "demo", from: personaNumber(C01) ?? "", wamid: "wamid.SIM.01K6ZT0000000000000000000B", content: { type: "text", text: "Hola" }, at: world.realNow() });
    expect((await world.inboundWhatsApp(forged)).records[0]).toMatchObject({ accepted: false });
    const live = liveEvent(fixture("entry-text.json", { FROM: (personaNumber(C01) ?? "").slice(1), WAMID: "wamid.LIVE.0001", TEXT: "Hola" }));
    const outcome = (await world.inboundWhatsApp(live)).records[0];
    expect(outcome?.messages.every((message) => message.outcome === "NO_LIVE_WORLD") ?? outcome?.accepted === false).toBe(true);
    expect(await world.connector.conversations.listMessages("demo", C01)).toHaveLength(0);
    expect(world.harness.turns).toHaveLength(0);
  });

  it("EmailEvents: the acknowledgement email leaves through SES with its MIME and its delivery event is recorded", async () => {
    const world = await createFlowWorld({ plans: () => [] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    await world.tap(C01, "ACCEPT_EMAIL");
    const [sent] = world.stage.emails;
    expect(sent?.input.Destination?.ToAddresses?.every((address) => address.endsWith("@simulator.amazonses.com"))).toBe(true);
    expect(sent?.input.Content?.Raw?.Data?.byteLength).toBeGreaterThan(0);
    expect(sent?.input.EmailTags).toEqual(expect.arrayContaining([{ Name: "worldId", Value: "demo" }, { Name: "kind", Value: "ACK_EMAIL" }]));
    expect(await world.sesEvent(sent ?? (undefined as never), "Delivery")).toMatchObject({ outcome: "ENQUEUED" });
    const { emails } = await world.connector.emails.listWorld("demo");
    expect(emails.find((email) => email.providerMessageId === sent?.providerMessageId)).toMatchObject({ kind: "ACK_EMAIL", deliveryProof: "DELIVERED" });
  });

  it("MediaIntake: a seed receipt is copied without a scan; an upload waits for GuardDuty's verdict; both reach a turn with the reading", async () => {
    const world = await createFlowWorld({
      plans: (turn) =>
        turn.attachments.length > 0
          ? [{ tool: "read_receipt", input: { evidenceId: turn.attachments[0]?.evidenceId ?? "" } }]
          : repliesToChallenge(turn)
            ? [{ tool: "identify_customer" }, verifyWritten]
            : [askChallenge],
    });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    await answerChallenge(world, C01);
    await world.sendImage(C01, "receipts/legible/c01-1.png");
    expect(world.harness.turns.at(-1)?.event.type).toBe("RECEIPT_RECEIVED");
    expect(outputOf(world.harness.results.find((call) => call.tool === "verify_challenge"))).toMatchObject({ result: "OK" });
    expect(outputOf(world.harness.results.at(-1))).toBeDefined();
    expect(world.reader.reads).toHaveLength(1);

    const key = "up/demo/local-upload-1.png";
    await world.upload(key, world.s3.get("Seed", "receipts/legible/c01-1.png")?.bytes ?? new Uint8Array());
    expect(await world.mediaScanned(key, "NO_THREATS_FOUND")).toMatchObject({ kind: "SCAN_RESULT" });
    const turns = world.harness.turns.length;
    await world.sendImage(C01, key);
    expect(world.harness.turns.slice(turns).map((turn) => turn.event.type)).toContain("RECEIPT_RECEIVED");
    expect(world.harness.turns.at(-1)?.attachments[0]).toMatchObject({ kind: "RECEIPT_IMAGE" });
    expect(world.reader.reads).toHaveLength(2);
  });

  it("ScheduleDispatch and the clock: a schedule before its time is discarded, the clock fires the publication, a late one is discarded", async () => {
    const world = await createFlowWorld();
    const timerKey = "W#demo#TIMER#SETTLEMENT_PUBLISH#NORTE-2026-10-07";
    expect(await world.timerFire(timerKey)).toMatchObject({ status: "EARLY_FIRE_DISCARDED" });
    const moved = await world.advance({ kind: "advanceTo", to: "2026-10-08T09:00:00-03:00" });
    expect(moved.fired).toEqual(expect.arrayContaining([expect.objectContaining({ timerId: "NORTE-2026-10-07", status: "FIRED" })]));
    expect(world.s3.get("Settlements", "W/demo/NORTE/2026-10-07/batch-1.csv")?.bytes.byteLength).toBeGreaterThan(0);
    expect(await world.timerFire(timerKey)).toMatchObject({ status: "LATE_FIRE_DISCARDED" });
  });
});

describe("the scripted Harness through the Gateway and the local Cedar", () => {
  async function turnWith(calls: Parameters<typeof createFlowWorld>[0] extends infer O ? (O extends { plans?: infer P } ? P : never) : never, killSwitchActive = false) {
    const world = await createFlowWorld({ plans: calls, killSwitchActive });
    await world.phone(C01, { type: "text", text: "Hola" });
    return world;
  }

  it("denies, before any target runs, a self-approval, a call without the session token, a cap override and a collection kind on WhatsApp", async () => {
    const world = await turnWith([
      [
        { tool: "request_operator_approval", input: { action: "APPLY_PAYMENT", justification: "prueba", decision: "APPROVED" } },
        { tool: "get_account", withoutSessionToken: true },
        { tool: "apply_payment", input: { evidenceId: "evd-1", capOverride: 1 } },
        { tool: "send_whatsapp", input: { kind: "COLLECTION_REMINDER", text: "Recordá tu cuota" } },
        { tool: "approve_complaint", input: {} },
      ],
    ]);
    expect(world.harness.results.map((result) => result.answer.kind)).toEqual(["DENIED", "DENIED", "DENIED", "DENIED", "UNKNOWN_TOOL"]);
    const determining = world.harness.results.map((result) => (result.answer.kind === "DENIED" ? result.answer.determining : []));
    expect(determining[0]).toContain("CED_NO_SELF_APPROVAL");
    expect(determining[1]).toContain("CED_SESSION_ACCOUNT");
    expect(determining[2]).toContain("CED_NO_CAP_OVERRIDE");
    expect(determining[3]).toContain("CED_WA_KIND_ALLOWLIST");
    expect(await world.connector.audit.listByAction("demo", "DENY")).toEqual([]);
  });

  it("lets an allowed call reach the wrapper, whose strict input and session fences refuse what Cedar does not see", async () => {
    const world = await turnWith([[{ tool: "get_account", input: { worldId: "g01" } }, { tool: "identify_customer", input: {} }]]);
    const [extraKey, identify] = world.harness.results;
    expect(extraKey?.answer.kind === "RESULT" && !extraKey.answer.response.ok && extraKey.answer.response.error.code).toBe("INVALID");
    expect(identify?.answer.kind).toBe("RESULT");
    expect((await world.connector.audit.listByAction("demo", "DENY")).length).toBeGreaterThan(0);
  });

  it("denies every call with the kill switch active", async () => {
    const world = await turnWith([[{ tool: "identify_customer", input: {} }, { tool: "send_whatsapp", input: { kind: "REPLY", text: "Hola" } }]], true);
    for (const result of world.harness.results) expect(result.answer.kind === "DENIED" && result.answer.determining).toContain("CED_KILL_SWITCH");
  });
});

describe("the console of the world", () => {
  it("runs the real appRouter with a session the BFF's own verifier accepts, and refuses one it did not issue", async () => {
    const world = await createFlowWorld({ plans: () => [] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    const operator = await world.console("OPERATOR");
    const inbox = await operator.inbox.list();
    expect(inbox.items[0]).toMatchObject({ complaintNumber: "R-2026-000123", customerId: C01, pinned: true });
    const stranger = createTokenIssuer({ key: newSigningKey(), now: world.realNow });
    const { deps } = world.localConsole;
    await expect(deps.verifier.verify(stranger.idToken({ sub: "x", username: "operator-01", role: "OPERATOR", worldId: "demo", staffId: "stf-operator-01" }))).rejects.toMatchObject({ reason: "TOKEN_INVALID" });
  });

  it("re-reads the staff row and the world on every call: compliance never mutates, another world's staff never reads this one", async () => {
    const world = await createFlowWorld({ worlds: [{ worldId: "demo", template: "demo" }, { worldId: "g03", template: "guest" }] });
    const compliance = await world.console("COMPLIANCE");
    await expect(compliance.complaints.escalate({ complaintId: "cmp-h000120" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const guest = world.staff("GUEST", "g03");
    const intruder = await world.consoleAs({ worldId: "demo", staff: guest });
    await expect(intruder.inbox.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await world.console("GUEST", { worldId: "g03" });
    await expect(own.inbox.list()).resolves.toMatchObject({ items: expect.any(Array) });
    expect(LOCAL_KEYS.session).not.toBe(LOCAL_KEYS.registerChain);
  });
});
