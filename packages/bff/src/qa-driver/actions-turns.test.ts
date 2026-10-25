import { describe, expect, it } from "vitest";
import { TEST_NOW, testConnector, worldMeta } from "../connector/testing";
import type { JsonObject } from "../domain/common";
import { GATE_AUDIT } from "../outbound/types";
import { worldsRig } from "../worlds/testing";
import { STAFF_TEXT } from "../copy/es-AR";
import { clauseIdsOf } from "./actions-turns";
import { triggerRefusal } from "./stage-cognito";
import { QA_WORLD, key, qaKit } from "./testing";

const CUSTOMER = `cus-${QA_WORLD}-a`;
const AT = TEST_NOW.toISOString();
const SIM = "2026-10-07T10:20:00-03:00";

async function readyWorld(mc: ReturnType<typeof testConnector>): Promise<void> {
  await mc.connector.worlds.register(worldMeta(QA_WORLD, { status: "READY" }));
}

function outbound(messageId: string, overrides: Record<string, unknown>) {
  return { worldId: QA_WORLD, customerId: CUSTOMER, messageId, direction: "OUT" as const, channel: "WHATSAPP" as const, body: "texto", simulated: true, flags: {}, atSim: SIM, status: "SENT" as const, ...overrides };
}

describe("turn.inspect (EV-1)", () => {
  it("lists per turn the clause ids of its tools and the G2 verdict of each answer, sent or refused", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    const { sessions, conversations, audit } = mc.connector;
    await sessions.putSession({ worldId: QA_WORLD, sessionId: "ses-1", customerId: CUSTOMER, complaintIds: [], identified: true, trigger: "CUSTOMER_MESSAGE", triggerEventId: "evt-1", turnId: "trn-1", eventAtSim: SIM, createdAtReal: AT });
    await sessions.openTurn({ worldId: QA_WORLD, turnId: "trn-1", sessionId: "ses-1", openedAtReal: AT });
    await sessions.putTurnResult(QA_WORLD, "trn-1", "get_terms", { clauses: [{ clauseId: "T-3.2", text: "…" }, { clauseId: "D-1" }] });
    await sessions.putTurnResult(QA_WORLD, "trn-1", "get_fee_rules", { fees: [{ code: "FEE-ORIG", clauseIds: ["T-4.1", "T-3.2"] }] });
    await conversations.putMessage(outbound("msg-1", { kind: "REPLY", turnId: "trn-1", g2: { groundingScore: 0.91, relevanceScore: 0.8 } }));
    await conversations.putMessage(outbound("msg-2", { kind: "REPLY", turnId: "trn-1", status: "BLOCKED", atSim: "2026-10-07T10:21:00-03:00" }));
    await conversations.putMessage(outbound("msg-3", { kind: "COMPLAINT_ACK", turnId: "trn-1", atSim: "2026-10-07T10:19:00-03:00" }));
    await audit.append({ worldId: QA_WORLD, epoch: 1, auditId: "aud-g2-1", ts: AT, action: GATE_AUDIT.G2_REFUSED, actor: "AGENT", ruleIds: ["G2"], refs: { messageId: "msg-2", kind: "REPLY", turnId: "trn-1" }, primaryRef: `CUS#${CUSTOMER}`, outcome: "GROUNDING", detail: { reason: "GROUNDING", groundingScore: 0.41, relevanceScore: 0.77 } });

    const answer = await qaKit({ mc }).driver({ action: "turn.inspect", idempotencyKey: key(1, "ev1"), input: { worldId: QA_WORLD, customerId: CUSTOMER } });
    expect(answer).toEqual({
      ok: true,
      replayed: false,
      result: {
        turns: [
          {
            turnId: "trn-1",
            tools: [
              { tool: "get_terms", clauseIds: ["D-1", "T-3.2"] },
              { tool: "get_fee_rules", clauseIds: ["T-3.2", "T-4.1"] },
            ],
            replies: [
              { kind: "REPLY", sent: true, g2: { action: "NONE", groundingScore: 0.91, relevanceScore: 0.8 } },
              { kind: "REPLY", sent: false, g2: { action: "BLOCKED", failure: "GROUNDING", groundingScore: 0.41, relevanceScore: 0.77 } },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(answer)).not.toContain("texto");
  });

  it("collects clause ids at any depth and nothing else", () => {
    expect([...clauseIdsOf({ a: [{ b: { clauseId: "X-1" } }], clauseIds: ["X-2", 3], other: "X-3" })].sort()).toEqual(["X-1", "X-2"]);
  });
});

describe("intake.inspect (EV-3)", () => {
  it("answers the customer's INTAKE_CLASSIFIED decisions, oldest first, without the text", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    const entry = (auditId: string, ts: string, outcome: string, detail: JsonObject) =>
      mc.connector.audit.append({ worldId: QA_WORLD, epoch: 1, auditId, ts, action: "INTAKE_CLASSIFIED", actor: "SYSTEM", outcome, refs: { channel: "WHATSAPP", customerId: CUSTOMER }, primaryRef: `CUS#${CUSTOMER}`, detail });
    await entry("wa-2", "2026-10-07T13:21:00.000Z", "RECLAMO", { source: "MODEL", confidence: 0.83, type: "UNRECOGNIZED_CHARGE", modelMs: 412 });
    await entry("wa-1", "2026-10-07T13:20:00.000Z", "UNCLEAR", { source: "FALLBACK", confidence: 0, fallback: "KILL_SWITCH" });
    const answer = await qaKit({ mc }).driver({ action: "intake.inspect", idempotencyKey: key(2, "ev3"), input: { worldId: QA_WORLD, customerId: CUSTOMER } });
    expect(answer).toMatchObject({
      ok: true,
      result: {
        classifications: [
          { kind: "UNCLEAR", source: "FALLBACK", confidence: 0, fallback: "KILL_SWITCH" },
          { kind: "RECLAMO", source: "MODEL", confidence: 0.83, type: "UNRECOGNIZED_CHARGE", modelMs: 412 },
        ],
      },
    });
  });
});

describe("snapshot", () => {
  it("[FL-001] carries each message's disclosure mark and button actions (never a nonce), and an image's scan resolution", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    await mc.connector.transact([mc.connector.counters.initEpochOp(QA_WORLD, 1)]);
    await mc.connector.runtime.putClock({ worldId: QA_WORLD, mode: "PAUSED", pausedSimNow: SIM, worldEpoch: 1 });
    const announceKey = `qa/x/${QA_WORLD}/sim/msg-in/0.png`;
    await mc.connector.conversations.putMessage(
      outbound("msg-out", { kind: "IDENTITY_CHALLENGE", flags: { disclosure: true }, interactive: { shape: "buttons", buttons: [{ action: "TALK_TO_HUMAN", nonce: "n-secret-1", title: "Hablar con una persona" }] } }),
    );
    await mc.connector.conversations.putMessage({ worldId: QA_WORLD, customerId: CUSTOMER, messageId: "msg-in", direction: "IN", channel: "WHATSAPP", body: "", simulated: true, flags: {}, atSim: SIM, status: "RECEIVED", media: { announceKey, s3Key: announceKey, contentType: "image/png" } });
    await mc.connector.scans.announce({ worldId: QA_WORLD, announceKey, s3Key: announceKey, source: "SIMULATOR", createdAtReal: AT });
    await mc.connector.scans.recordResult(QA_WORLD, announceKey, { status: "NO_THREATS_FOUND", objectKey: announceKey });
    await mc.connector.scans.bind(QA_WORLD, announceKey, { messageId: "msg-in", customerId: CUSTOMER, pending: { worldId: QA_WORLD, kind: "SCAN", pendingId: "scan-1", openedAtReal: AT, customerId: CUSTOMER } });
    await mc.connector.scans.markResolved(QA_WORLD, announceKey, "RESULT_FIRST");
    const answer = await qaKit({ mc }).driver({ action: "snapshot", idempotencyKey: key(3), input: { worldId: QA_WORLD, customerId: CUSTOMER } });
    expect(JSON.stringify(answer)).not.toContain("n-secret-1");
    const messages = (answer as { result: { messages: Record<string, unknown>[] } }).result.messages;
    expect(messages.find((message) => message["messageId"] === "msg-out")).toMatchObject({ disclosure: true, buttons: [{ action: "TALK_TO_HUMAN", title: "Hablar con una persona" }], scan: null });
    expect(messages.find((message) => message["messageId"] === "msg-in")).toMatchObject({ disclosure: false, buttons: [], scan: { result: "NO_THREATS_FOUND", resolution: "RESULT_FIRST" } });
  });
});

describe("Cognito probes", () => {
  it("[FL-119] reports the web ACL's answer to the ServerClient and the ConsoleClient for the world's SUPERVISOR", async () => {
    const mc = testConnector();
    await readyWorld(mc);
    const kit = qaKit({ mc });
    const answer = await kit.driver({ action: "probe.cognitoClients", idempotencyKey: key(4, "smk"), input: { worldId: QA_WORLD.replace("sc01", "smk") } });
    expect(answer).toMatchObject({ ok: true, result: { refused: true, answers: { SERVER: { forgotPassword: "ForbiddenException" }, CONSOLE: { signUp: "ForbiddenException" } } } });
    // The driver never lists the pool (a self-signup's username is the lead's email): no such action.
    expect(await kit.driver({ action: "probe.staffEmails", idempotencyKey: key(5, "smk"), input: {} })).toMatchObject({ ok: false });
  });

  it("[FL-121] reads a sign-in the pre-token trigger refused as FORBIDDEN WORLD_NOT_READY or ACCESS_DENIED", () => {
    const refused = (message: string) => Object.assign(new Error(`PreTokenGeneration failed with error ${message}.`), { name: "UserLambdaValidationException" });
    expect(triggerRefusal(refused(STAFF_TEXT.WORLD_NOT_READY))).toMatchObject({ code: "FORBIDDEN", reason: "WORLD_NOT_READY" });
    expect(triggerRefusal(refused("Acceso denegado"))).toMatchObject({ code: "FORBIDDEN", reason: "ACCESS_DENIED" });
    expect(triggerRefusal(Object.assign(new Error("x"), { name: "NotAuthorizedException" }))).toBeUndefined();
  });

  it("refuses the probe outside the run's own worlds", async () => {
    const kit = qaKit({ mc: testConnector() });
    expect(await kit.driver({ action: "probe.cognitoClients", idempotencyKey: key(6, "smk"), input: { worldId: "demo" } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("guest.invite({registerOnly})", () => {
  it("[FL-121] pre-registers the account and leaves the world REGISTERED; a later invite builds it", async () => {
    const worlds = worldsRig();
    const kit = qaKit({ mc: worlds.mc, worlds: () => worlds.deps });
    const worldId = QA_WORLD.replace("sc01", "sc22j");
    const first = await kit.driver({ action: "guest.invite", idempotencyKey: key(8, "sc22", "pre"), input: { worldId, registerOnly: true } });
    expect(first).toMatchObject({ ok: true, result: { sessionKey: "guest", status: "REGISTERED" } });
    expect(await worlds.mc.connector.worlds.getMeta(worldId)).toMatchObject({ status: "REGISTERED" });
    expect(await worlds.mc.connector.worlds.getStaff(worldId, "stf-qa-guest")).toMatchObject({ role: "GUEST" });
    const built = await kit.driver({ action: "guest.invite", idempotencyKey: key(8, "sc22", "build"), input: { worldId } });
    expect(built).toMatchObject({ ok: true, result: { status: "READY" } });
  });
});
