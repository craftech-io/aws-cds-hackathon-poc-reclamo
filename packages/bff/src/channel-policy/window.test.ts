import { describe, expect, it } from "vitest";
import { evaluate } from "./engine";
import { OPERATOR, OPERATOR_STAFF, REAL_NOW, agentReply, inbound, proactiveUpdate, takenAt } from "./testing";

const LAST_INBOUND = "2026-10-07T10:04:00-03:00";
const TWENTY_SIX_HOURS_LATER = "2026-10-08T12:04:00-03:00";
const operatorTaken = { conversation: takenAt("2026-10-08T12:00:00-03:00"), request: { sender: OPERATOR, auth: { staff: OPERATOR_STAFF } } } as const;

describe("[FL-069] outside the 24-hour window", () => {
  it("[FL-069] free text 26 hours after the customer's last message is blocked with TEMPLATE_REQUIRED", () => {
    const decision = evaluate(agentReply({ ...operatorTaken, at: TWENTY_SIX_HOURS_LATER }));
    expect(decision).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-WA-24H"], errorCode: "TEMPLATE_REQUIRED", reply: false, window: { state: "CLOSED", closesAt: "2026-10-08T10:04:00-03:00" } });
  });

  it("[FL-069] the reclamo_novedad template with a phrase of the closed list goes out", () => {
    const decision = evaluate(proactiveUpdate({ at: TWENTY_SIX_HOURS_LATER, history: [inbound("msg-in-01", LAST_INBOUND)] }));
    expect(decision.decision).toBe("ALLOWED");
    expect(decision.evaluated.find((entry) => entry.ruleId === "CH-WA-24H")?.detail).toContain("reclamo_novedad");
  });

  it("[FL-069] a free {{3}} is TEMPLATE_PARAM_NOT_ALLOWED, inside or outside the window", () => {
    const free = { name: "reclamo_novedad" as const, params: ["Valeria", "R-2026-000001", "ya te depositamos todo"] };
    for (const at of [TWENTY_SIX_HOURS_LATER, "2026-10-07T10:10:00-03:00"]) {
      const decision = evaluate(proactiveUpdate({ at, request: { template: free } }));
      expect(decision, at).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-WA-24H"], errorCode: "TEMPLATE_PARAM_NOT_ALLOWED" });
    }
    const short = { name: "reclamo_novedad" as const, params: ["Valeria"] };
    expect(evaluate(proactiveUpdate({ request: { template: short } })).errorCode).toBe("TEMPLATE_PARAM_NOT_ALLOWED");
  });

  it("[FL-069] the edge: open until 23:59 after the last message, closed at 24:00", () => {
    expect(evaluate(agentReply({ ...operatorTaken, at: "2026-10-08T10:03:59-03:00" })).decision).toBe("ALLOWED");
    expect(evaluate(agentReply({ ...operatorTaken, at: "2026-10-08T10:04:00-03:00" })).ruleIds).toEqual(["CH-WA-24H"]);
  });

  it("[FL-069] the agent's reply to a message older than 24 hours is no reply: it is proactive and needs a template", () => {
    const decision = evaluate(agentReply({ at: TWENTY_SIX_HOURS_LATER }));
    expect(decision.reply).toBe(false);
    expect(decision.ruleIds).toEqual(["CH-WA-24H"]);
  });
});

describe("the window's clock", () => {
  it("simulated WhatsApp measures the world's clock: two simulated days close it, whatever the real time", () => {
    const decision = evaluate(agentReply({ ...operatorTaken, at: "2026-10-09T10:05:00-03:00", realAt: REAL_NOW }));
    expect(decision.window?.state).toBe("CLOSED");
  });

  it("live WhatsApp measures real time: a paused world keeps it open only while real time allows", () => {
    const live = { modes: { whatsapp: "live" as const, email: "live" as const }, request: { ...operatorTaken.request, to: "+5491100009999" }, conversation: operatorTaken.conversation };
    const realInbound = "2026-10-06T15:00:00.000Z";
    const history = [inbound("msg-in-01", LAST_INBOUND, realInbound)];
    expect(evaluate(agentReply({ ...live, history, at: "2026-10-09T10:05:00-03:00", realAt: "2026-10-06T16:00:00.000Z" })).window?.state).toBe("OPEN");
    expect(evaluate(agentReply({ ...live, history, at: LAST_INBOUND, realAt: "2026-10-07T15:00:00.000Z" })).ruleIds).toEqual(["CH-WA-24H"]);
  });
});

describe("what makes a send a reply", () => {
  it("a turn the customer's message opened, an explicit answer, or a conversational kind inside the window", () => {
    expect(evaluate(agentReply()).reply).toBe(true);
    expect(evaluate(agentReply({ request: { trigger: undefined, answers: "msg-in-01" } })).reply).toBe(true);
    expect(evaluate(agentReply({ request: { trigger: undefined } })).reply).toBe(true);
    expect(evaluate(agentReply({ request: { trigger: undefined, answers: "msg-in-unknown" } })).reply).toBe(false);
  });

  it("a template or an update the system starts is never a reply", () => {
    expect(evaluate(proactiveUpdate({ history: [inbound("msg-in-01", LAST_INBOUND)] })).reply).toBe(false);
    expect(evaluate(agentReply({ request: { kind: "COMPLAINT_UPDATE", trigger: "SETTLEMENT_PUBLISHED" } })).reply).toBe(false);
  });

  it("an email is never a reply and carries no window", () => {
    const decision = evaluate(proactiveUpdate({ request: { channel: "EMAIL" } }));
    expect(decision.reply).toBe(false);
    expect(decision.window).toBeUndefined();
  });
});
