import { afterEach, describe, expect, it, vi } from "vitest";
import { type AsOfFacts, evaluateAsOf } from "./as-of";
import { consentHistoryOf, policyCustomerOf } from "./consent";
import { evaluate } from "./engine";
import type { PolicyInput } from "./types";
import { AGENT_HOLDS, REAL_NOW, SEEDED_OPT_IN, SETTINGS, VALERIA, VALERIA_COMPLAINT, complaintOf, inbound, optedIn, sent, takenAt } from "./testing";

const SENT_AT = "2026-10-07T11:00:00-03:00";
const BEFORE = "2026-10-07T10:30:00-03:00";
const AFTER = "2026-10-07T11:30:00-03:00";

/** A stored proactive WhatsApp update to Valeria and the rows PolicyAudit loads for it. */
function update(overrides: Partial<AsOfFacts> = {}, message: Partial<AsOfFacts["message"]> = {}): AsOfFacts {
  return {
    worldId: "demo",
    customerId: VALERIA,
    message: { messageId: "msg-out-01", channel: "WHATSAPP", kind: "COMPLAINT_UPDATE", sender: "AGENT", body: "Hola Valeria, hay una novedad en tu reclamo R-2026-000001: ya tenemos la rendición de la red. Podés responder por acá.", complaintId: VALERIA_COMPLAINT, templateName: "reclamo_novedad", sentAtSim: SENT_AT, sentAtReal: REAL_NOW, simulated: true, ...message },
    trigger: "SETTLEMENT_PUBLISHED",
    consent: optedIn(VALERIA).consentHistory,
    conversation: AGENT_HOLDS,
    complaint: complaintOf(VALERIA),
    history: [],
    settings: SETTINGS,
    ...overrides,
  };
}

const optOutAt = (atSim: string, atReal?: string) => [...optedIn(VALERIA).consentHistory, { action: "OPT_OUT" as const, atSim, ...(atReal === undefined ? {} : { atReal }) }];
const closedAt = (atSim: string) => complaintOf(VALERIA, { status: "CLOSED", statusHistory: [...complaintOf(VALERIA).statusHistory, { from: "ANSWERED", to: "CLOSED", atSim }] });

describe("the policy at the instant a message went out", () => {
  afterEach(() => vi.useRealTimers());

  it("allows a clean send of the past", () => {
    const decision = evaluateAsOf(update());
    expect(decision.decision).toBe("ALLOWED");
    expect(decision.evaluated.filter((entry) => entry.result === "SKIP").map((entry) => entry.ruleId)).toEqual(expect.arrayContaining(["CH-SENDER", "CH-NO-SENSITIVE-ASK", "CH-NO-FOREIGN-LINKS"]));
  });

  it("an opt-out, a takeover or a closed complaint recorded after the send never makes it a breach", () => {
    expect(evaluateAsOf(update({ consent: optOutAt(AFTER) })).decision).toBe("ALLOWED");
    expect(evaluateAsOf(update({ conversation: takenAt(AFTER) })).decision).toBe("ALLOWED");
    expect(evaluateAsOf(update({ complaint: closedAt(AFTER) })).decision).toBe("ALLOWED");
  });

  it("one in force when it went out always does", () => {
    expect(evaluateAsOf(update({ consent: optOutAt(BEFORE) })).ruleIds).toEqual(["CH-OPTOUT"]);
    expect(evaluateAsOf(update({ conversation: takenAt(BEFORE) })).ruleIds).toEqual(["CH-CONTROL"]);
    expect(evaluateAsOf(update({ complaint: closedAt(BEFORE) })).ruleIds).toEqual(["CH-WA-CUSTOMER-INITIATED"]);
    expect(evaluateAsOf(update({ consent: [] })).ruleIds).toEqual(["CH-OPTIN"]);
  });

  it("in a paused world a step dated at the send's own simulated instant counts only if it was recorded before it", () => {
    const later = new Date(Date.parse(REAL_NOW) + 20_000).toISOString();
    const earlier = new Date(Date.parse(REAL_NOW) - 20_000).toISOString();
    expect(evaluateAsOf(update({ conversation: takenAt(SENT_AT, undefined, later) })).decision).toBe("ALLOWED");
    expect(evaluateAsOf(update({ conversation: takenAt(SENT_AT, undefined, earlier) })).ruleIds).toEqual(["CH-CONTROL"]);
    expect(evaluateAsOf(update({ consent: optOutAt(SENT_AT, later) })).decision).toBe("ALLOWED");
    expect(evaluateAsOf(update({ consent: optOutAt(SENT_AT, earlier) })).ruleIds).toEqual(["CH-OPTOUT"]);
    // Without its real instant, a same-instant step gets the benefit of the doubt: the ALLOWED entry proves what the gate saw.
    expect(evaluateAsOf(update({ conversation: takenAt(SENT_AT) })).decision).toBe("ALLOWED");
  });

  it("rebuilds the window and the daily cap from the dated history", () => {
    const reply = update({ trigger: "CUSTOMER_MESSAGE", history: [inbound("msg-in-01", "2026-10-07T10:50:00-03:00")] }, { kind: "REPLY", body: "Ya la estamos revisando.", templateName: undefined });
    expect(evaluateAsOf(reply).decision).toBe("ALLOWED");
    const late = update({ trigger: "CUSTOMER_MESSAGE", history: [inbound("msg-in-01", "2026-10-06T10:50:00-03:00")] }, { kind: "REPLY", body: "Ya la estamos revisando.", templateName: undefined });
    expect(evaluateAsOf(late).ruleIds).toEqual(["CH-WA-24H"]);
    const three = ["10:20", "10:30", "10:40"].map((time, n) => sent(`msg-o${n}`, "COMPLAINT_UPDATE", `2026-10-07T${time}:00-03:00`));
    expect(evaluateAsOf(update({ history: three })).ruleIds).toEqual(["CH-MAX-PER-DAY"]);
    const third = update({ history: [...three.slice(0, 2), sent("msg-o9", "COMPLAINT_UPDATE", "2026-10-07T12:00:00-03:00")] });
    expect(evaluateAsOf(third).decision).toBe("ALLOWED");
    expect(evaluateAsOf(update({ history: three }, { messageId: "msg-o2", sentAtSim: "2026-10-07T10:40:00-03:00" })).decision).toBe("ALLOWED");
  });

  it("re-reads the stored body for collection, and lists every breach in exhaustive mode", () => {
    const collected = update({ consent: optOutAt(BEFORE) }, { body: "Pagá tu cuota hoy para evitar recargos" });
    expect(evaluateAsOf(collected, { exhaustive: true }).ruleIds).toEqual(["CH-WA-NO-COLLECTION", "CH-OPTOUT"]);
  });

  it("a live message ran its window on real time", () => {
    const live = update({ trigger: "CUSTOMER_MESSAGE", history: [inbound("msg-in-01", "2026-10-05T10:50:00-03:00", "2026-10-07T13:00:00.000Z")] }, { kind: "REPLY", body: "Ya la estamos revisando.", templateName: undefined, simulated: false, sentAtReal: "2026-10-07T14:00:00.000Z" });
    expect(evaluateAsOf(live).decision).toBe("ALLOWED");
  });

  it("never reads the machine's clock", () => {
    const facts = [update(), update({ consent: optOutAt(BEFORE) })];
    const before = facts.map((item) => evaluateAsOf(item));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T03:00:00Z"));
    expect(facts.map((item) => evaluateAsOf(item))).toEqual(before);
  });
});

describe("consent from the core's state", () => {
  it("rebuilds the dated steps the gate and PolicyAudit share", () => {
    const state = { optedIn: true, optedInAtSim: SEEDED_OPT_IN, optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: true, optedOutAtSim: BEFORE };
    expect(consentHistoryOf(state)).toEqual([
      { action: "OPT_IN", atSim: SEEDED_OPT_IN, medium: "SIGNED_ONBOARDING", textVersion: "v001" },
      { action: "OPT_OUT", atSim: BEFORE },
    ]);
    expect(evaluateAsOf(update({ consent: state })).ruleIds).toEqual(["CH-OPTOUT"]);
    expect(consentHistoryOf({ optedIn: false, optedOut: false })).toEqual([]);
  });

  it("a send decided now also honours the current flags", () => {
    const customer = policyCustomerOf(VALERIA, { optedIn: true, optedInAtSim: SEEDED_OPT_IN, optedOut: true });
    const input: PolicyInput = { request: { worldId: "demo", customerId: VALERIA, complaintId: VALERIA_COMPLAINT, sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_UPDATE", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000001", "ANSWER_SENT"] } }, customer, conversation: AGENT_HOLDS, complaint: complaintOf(VALERIA), history: [], clock: { simNow: SENT_AT, realNow: REAL_NOW }, modes: { whatsapp: "simulated" }, settings: SETTINGS };
    expect(evaluate(input).ruleIds).toEqual(["CH-OPTOUT"]);
  });
});
