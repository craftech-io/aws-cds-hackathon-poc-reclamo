import { describe, expect, it } from "vitest";
import { toArIso } from "./checks";
import { evaluate } from "./engine";
import { contactSchedule, formalNoticeSchedule, nextOpening } from "./hours";
import { HOLIDAYS, SETTINGS, agentReply, formalNotice, inbound, proactiveUpdate, sent, updateByEmail } from "./testing";

const at = (iso: string) => new Date(iso);
const weekly = contactSchedule(SETTINGS.contactHours, HOLIDAYS);
const formal = formalNoticeSchedule(SETTINGS.contactHours, HOLIDAYS);

describe("[FL-070] contact hours and holidays", () => {
  it("[FL-070] defers a proactive update on Saturday 10/10 at 18:00 to Tuesday 13/10 08:00 (Sunday closed, Monday 12/10 a holiday)", () => {
    const decision = evaluate(proactiveUpdate({ at: "2026-10-10T18:00:00-03:00" }));
    expect(decision).toMatchObject({ decision: "DEFERRED", ruleIds: ["CH-CONTACT-HOURS"], errorCode: "DEFERRED", nextAllowedAt: "2026-10-13T08:00:00-03:00" });
    expect(decision.reason).toBe("SAT 10/10 18:00 is outside the contact hours: deferred to TUE 13/10 08:00");
    expect(evaluate(proactiveUpdate({ at: decision.nextAllowedAt })).decision).toBe("ALLOWED");
  });

  it("[FL-070] a reply to the customer's own message is never deferred", () => {
    const reply = agentReply({ at: "2026-10-10T18:00:00-03:00", history: [inbound("msg-in-sat", "2026-10-10T17:55:00-03:00")] });
    expect(evaluate(reply).decision).toBe("ALLOWED");
    expect(evaluate(agentReply({ at: "2026-10-12T23:30:00-03:00", history: [inbound("msg-in-hol", "2026-10-12T23:29:00-03:00")] })).decision).toBe("ALLOWED");
  });

  it("[FL-070] the edges: 08:00 and 19:59 are in, 20:00 and 07:59 are out; Saturday 09:00 to 12:59", () => {
    expect(evaluate(proactiveUpdate({ at: "2026-10-07T08:00:00-03:00" })).decision).toBe("ALLOWED");
    expect(evaluate(proactiveUpdate({ at: "2026-10-07T19:59:00-03:00" })).decision).toBe("ALLOWED");
    expect(evaluate(proactiveUpdate({ at: "2026-10-07T20:00:00-03:00" })).nextAllowedAt).toBe("2026-10-08T08:00:00-03:00");
    expect(evaluate(proactiveUpdate({ at: "2026-10-07T07:59:00-03:00" })).nextAllowedAt).toBe("2026-10-07T08:00:00-03:00");
    expect(evaluate(proactiveUpdate({ at: "2026-10-10T12:59:00-03:00" })).decision).toBe("ALLOWED");
    expect(evaluate(proactiveUpdate({ at: "2026-10-10T08:30:00-03:00" })).nextAllowedAt).toBe("2026-10-10T09:00:00-03:00");
    expect(evaluate(proactiveUpdate({ at: "2026-10-10T13:00:00-03:00" })).nextAllowedAt).toBe("2026-10-13T08:00:00-03:00");
  });

  it("[FL-070] email updates follow the same hours; the written answer and the confirmations are exempt", () => {
    expect(evaluate(updateByEmail({ at: "2026-10-11T11:00:00-03:00" })).nextAllowedAt).toBe("2026-10-13T08:00:00-03:00");
    const answer = updateByEmail({ at: "2026-10-11T23:00:00-03:00", request: { sender: "AGENT", auth: { agentSessionValid: true }, kind: "FORMAL_ANSWER", rerouteOf: undefined, formal: { outcome: "IN_FAVOUR" } } });
    expect(evaluate(answer).decision).toBe("ALLOWED");
  });

  it("[FL-070] the formal debt notice only Monday to Friday 09:00-18:00", () => {
    expect(evaluate(formalNotice({ at: "2026-10-07T08:30:00-03:00" })).nextAllowedAt).toBe("2026-10-07T09:00:00-03:00");
    expect(evaluate(formalNotice({ at: "2026-10-09T18:00:00-03:00" })).nextAllowedAt).toBe("2026-10-13T09:00:00-03:00");
    expect(evaluate(formalNotice({ at: "2026-10-10T10:00:00-03:00" })).nextAllowedAt).toBe("2026-10-13T09:00:00-03:00");
    expect(evaluate(formalNotice({ at: "2026-10-07T17:59:00-03:00" })).decision).toBe("ALLOWED");
  });

  it("[FL-070] the daily cap and the hours combine into one next instant", () => {
    const busyFriday = ["08:00", "09:00", "10:00"].map((time, n) => sent(`msg-o${n}`, "COMPLAINT_UPDATE", `2026-10-09T${time}:00-03:00`));
    const decision = evaluate(proactiveUpdate({ at: "2026-10-09T19:00:00-03:00", history: busyFriday }));
    expect(decision).toMatchObject({ decision: "DEFERRED", ruleIds: ["CH-MAX-PER-DAY"], nextAllowedAt: "2026-10-10T09:00:00-03:00" });
  });
});

describe("next opening", () => {
  it("keeps an instant inside the schedule and moves one outside to the next opening", () => {
    expect(toArIso(nextOpening(at("2026-10-07T10:10:00-03:00"), weekly))).toBe("2026-10-07T10:10:00-03:00");
    expect(toArIso(nextOpening(at("2026-10-11T10:00:00-03:00"), weekly))).toBe("2026-10-13T08:00:00-03:00");
    expect(toArIso(nextOpening(at("2026-12-24T21:00:00-03:00"), weekly))).toBe("2026-12-26T09:00:00-03:00");
    expect(toArIso(nextOpening(at("2026-12-24T21:00:00-03:00"), formal))).toBe("2026-12-28T09:00:00-03:00");
  });

  it("reads Argentine wall time whatever the zone of the instant", () => {
    expect(toArIso(nextOpening(at("2026-10-07T23:30:00Z"), weekly))).toBe("2026-10-08T08:00:00-03:00");
  });

  it("refuses a schedule that never opens", () => {
    expect(() => nextOpening(at("2026-10-07T10:00:00-03:00"), () => null)).toThrow(RangeError);
  });
});
