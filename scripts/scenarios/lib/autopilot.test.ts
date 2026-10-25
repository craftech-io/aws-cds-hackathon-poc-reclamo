import { describe, expect, it } from "vitest";
import { WHATSAPP_TEXT } from "@reclamo/bff/copy/es-AR";
import { challengeKindOf, drive, newProgress, nextMove, recordMove } from "./autopilot";
import { challengeAnswer, dayMonth, pesos, truthOf, wrongAnswer } from "./personas";
import { emptyRecord, defineScenario, stepContext } from "./steps";
import { fakeDriver, fakeTime, message, refusedWith, snapshotStub } from "./testing";

// C01 of the models template (docs/seed-spec.md §8): 12 instalments of $ 118.640,00, the 4th due Mon 05/10.
const C01 = truthOf("C01");
const PLAN = { persona: "a", model: "C01" } as const;
const WED_1010 = "2026-10-07T13:10:00.000Z";

const challenge = (text: string) => message({ kind: "IDENTITY_CHALLENGE", body: text });
const inbound = (text: string) => message({ direction: "IN", kind: null, body: text, status: "RECEIVED" });

describe("autopilot: the identity challenge with the persona's truth (docs/test-plan.md §4.3) [FL-003]", () => {
  it("tells the challenge kinds apart from the copy's prompts and from the agent's own words", () => {
    expect(challengeKindOf(WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE)).toBe("LAST_DUE_DATE");
    expect(challengeKindOf(WHATSAPP_TEXT.CHALLENGE_LAST_INSTALMENT_AMOUNT)).toBe("LAST_INSTALMENT_AMOUNT");
    expect(challengeKindOf(WHATSAPP_TEXT.CHALLENGE_LAST_MOVEMENT_AMOUNT)).toBe("LAST_MOVEMENT_AMOUNT");
    expect(challengeKindOf("Valeria, antes de seguir: ¿cuándo venció tu última cuota?")).toBe("LAST_DUE_DATE");
    expect(challengeKindOf("¿Cuánto pagaste de cuota la última vez?")).toBe("LAST_INSTALMENT_AMOUNT");
    expect(challengeKindOf("Gracias, ya lo tengo.")).toBeUndefined();
  });

  it("answers with the latest instalment already due at the world's simulated now, as the core compares it", () => {
    expect(C01.instalments).toHaveLength(12);
    expect(challengeAnswer(C01, "LAST_DUE_DATE", WED_1010)).toBe("5/10");
    expect(challengeAnswer(C01, "LAST_INSTALMENT_AMOUNT", WED_1010)).toBe("$ 118.640,00");
    // Before the first instalment fell due there is nothing to ask about.
    expect(challengeAnswer(C01, "LAST_DUE_DATE", "2026-06-01T12:00:00.000Z")).toBeUndefined();
    expect(challengeAnswer(C01, "LAST_MOVEMENT_AMOUNT", WED_1010)).toMatch(/^\$ [\d.]+,\d{2}$/);
  });

  it("formats dates and amounts the way a customer writes them", () => {
    expect(dayMonth("2026-10-05")).toBe("5/10");
    expect(pesos(11_864_000)).toBe("$ 118.640,00");
    expect(pesos(250_000)).toBe("$ 2.500,00");
    expect(pesos(5)).toBe("$ 0,05");
  });

  it("answers the pending challenge once, and a wrong value when the step proves two failures [FL-004]", () => {
    const asked = challenge(WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE);
    const snapshot = snapshotStub({ messages: [inbound("Pagué la cuota 4"), message({ kind: "COMPLAINT_ACK" }), asked] });
    const progress = newProgress();
    const move = nextMove(snapshot, PLAN, progress, C01);
    expect(move).toEqual({ kind: "challenge", messageId: asked.messageId, challenge: "LAST_DUE_DATE", content: { type: "text", text: "5/10" } });
    if (move === undefined) throw new Error("no move");
    recordMove(progress, move, "SENT", 2);
    expect(nextMove(snapshot, PLAN, progress, C01)).toBeUndefined();
    expect(nextMove(snapshot, { ...PLAN, challenge: "WRONG" }, newProgress(), C01)).toMatchObject({ content: { type: "text", text: wrongAnswer("LAST_DUE_DATE") } });
  });

  it("never answers a challenge the customer already replied to, nor writes when nothing is pending", () => {
    const answered = snapshotStub({ messages: [challenge(WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE), inbound("5/10")] });
    expect(nextMove(answered, PLAN, newProgress(), C01)).toBeUndefined();
    expect(nextMove(snapshotStub({ messages: [message({ kind: "REPLY", body: "Listo." })] }), PLAN, newProgress(), C01)).toBeUndefined();
  });
});

describe("autopilot: receipts and buttons the scenario declares", () => {
  it("sends the next receipt only for a pending RECEIPT_REQUEST, one per request", () => {
    const request = message({ kind: "RECEIPT_REQUEST", body: "¿Me mandás otra foto?" });
    const receipts = [{ type: "receipt", variant: "blurry", personaModel: "C16", seq: 2 }] as const;
    const progress = newProgress();
    const move = nextMove(snapshotStub({ messages: [request] }), { persona: "a", model: "C16", receipts }, progress, truthOf("C16"));
    expect(move).toEqual({ kind: "receipt", messageId: request.messageId, content: receipts[0] });
    if (move === undefined) throw new Error("no move");
    recordMove(progress, move, "SENT", 1);
    const again = message({ kind: "RECEIPT_REQUEST", body: "Otra más" });
    expect(nextMove(snapshotStub({ messages: [request, inbound("foto"), again] }), { persona: "a", model: "C16", receipts }, progress, truthOf("C16"))).toBeUndefined();
  });

  it("taps each declared button once, and asks again only after a new outbound message [FL-011]", () => {
    const plan = { ...PLAN, buttons: ["ACCEPT_EMAIL"] as const };
    const progress = newProgress();
    const one = snapshotStub({ messages: [message({ kind: "COMPLAINT_ACK" })] });
    const move = nextMove(one, plan, progress, C01);
    expect(move).toEqual({ kind: "button", action: "ACCEPT_EMAIL", content: { type: "button", action: "ACCEPT_EMAIL" } });
    if (move === undefined) throw new Error("no move");
    recordMove(progress, move, "NOT_OFFERED", 1);
    expect(nextMove(one, plan, progress, C01)).toBeUndefined();
    const two = snapshotStub({ messages: [...one.messages, message({ kind: "REPLY" })] });
    expect(nextMove(two, plan, progress, C01)).toMatchObject({ kind: "button", action: "ACCEPT_EMAIL" });
    recordMove(progress, move, "SENT", 2);
    expect(nextMove(two, plan, progress, C01)).toBeUndefined();
  });

  it("a pending challenge goes before a declared button", () => {
    const snapshot = snapshotStub({ messages: [message({ kind: "COMPLAINT_ACK" }), challenge(WHATSAPP_TEXT.CHALLENGE_LAST_INSTALMENT_AMOUNT)] });
    expect(nextMove(snapshot, { ...PLAN, buttons: ["ACCEPT_EMAIL"] }, newProgress(), C01)).toMatchObject({ kind: "challenge", content: { text: "$ 118.640,00" } });
  });
});

describe("autopilot: drive against the driver", () => {
  const scenario = defineScenario({ id: "SC-01", slug: "sc01", title: "t", suites: ["full"], steps: [] });

  it("plays one move per pending request until the state holds; a button nobody offers is not an error", async () => {
    const asked = challenge(WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE);
    let identified = false;
    const driver = fakeDriver({
      snapshot: () => ({ ok: true, replayed: false, result: snapshotStub({ messages: identified ? [asked, inbound("5/10"), message({ kind: "REPLY" })] : [asked] }) }),
      "wa.inbound": (input) => {
        const content = (input as { content: { type: string } }).content;
        if (content.type === "button") return refusedWith("NOT_FOUND", "SIM_BUTTON_NOT_FOUND")(input, "");
        identified = true;
        return { ok: true, replayed: false, result: { accepted: true } };
      },
    });
    const time = fakeTime();
    const ctx = stepContext({ runId: "812-1", scenario, driver, state: {}, waitOptions: time }, 4, emptyRecord());
    const done = await drive(ctx, { worldId: "qa-812-1-sc01", customerId: "cus-a", plan: { ...PLAN, buttons: ["ACCEPT_EMAIL"] }, until: (snapshot) => snapshot.messages.some((one) => one.kind === "REPLY"), what: "identified", timeoutSec: 60 });
    expect(done.messages).toHaveLength(3);
    const sent = driver.calls.filter((call) => call.action === "wa.inbound").map((call) => (call.input as { content: unknown }).content);
    expect(sent).toEqual([{ type: "text", text: "5/10" }]);
  });
});
