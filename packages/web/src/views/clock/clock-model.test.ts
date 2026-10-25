// The demo clock's rules as the console shows them (FL-082): the bounded compression of a live clock, its
// presets, the live window left, why a busy world waits and from when "Avanzar igual" is accepted, and
// what each upcoming timer is.
import { describe, expect, it } from "vitest";
import { LIVE_RATE, MAX_RATE, SLOW_LIVE_RATE, busyText, describeRate, forceAllowed, liveMinutesLeft, parseRate, realClockText, timerLabel } from "./clock-model";
import { clockCopy } from "./copy";

describe("the live clock's compression [FL-082]", () => {
  it("accepts only whole rates from 1 to 2,880, the console's bound", () => {
    expect(MAX_RATE).toBe(2_880);
    expect(parseRate("1")).toBe(1);
    expect(parseRate(" 2880 ")).toBe(2_880);
    for (const text of ["0", "2881", "1.5", "-3", "", "abc", "1e3"]) expect(parseRate(text), text).toBeUndefined();
  });

  it("says how long a simulated day takes in real time, for the presets and any rate", () => {
    expect(describeRate(LIVE_RATE)).toBe("1 día simulado cada 60 s reales");
    expect(describeRate(SLOW_LIVE_RATE)).toBe("1 día simulado cada 5 min reales");
    expect(describeRate(2_880)).toBe("1 día simulado cada 30 s reales");
    expect(describeRate(1)).toBe("1 día simulado cada 24 h reales");
  });

  it("counts the real minutes left of a live window, rounded up", () => {
    const now = Date.parse("2026-10-07T13:10:00Z");
    expect(liveMinutesLeft("2026-10-07T13:40:00Z", now)).toBe(30);
    expect(liveMinutesLeft("2026-10-07T13:10:30Z", now)).toBe(0);
    expect(liveMinutesLeft(undefined, now)).toBeUndefined();
  });
});

describe("a busy world [FL-082]", () => {
  const busy = { reason: "EMAIL_PENDING", pending: [], forceAllowedAtReal: "2026-10-07T13:15:00.000Z" };

  it("names what it waits for in words, never the raw code, in Spanish or English", () => {
    expect(busyText("EMAIL_PENDING")).toBe("un email esperando su evento de entrega de SES");
    expect(busyText("EVENT_IN_FLIGHT", "en")).toBe("an agent turn or a queued event");
    expect(busyText("SOMETHING_NEW")).not.toMatch(/[A-Z]{3,}_/);
  });

  it("accepts “Avanzar igual” only from the instant the BFF does, shown in Argentina time", () => {
    expect(forceAllowed(busy, Date.parse("2026-10-07T13:14:59Z"))).toBe(false);
    expect(forceAllowed(busy, Date.parse("2026-10-07T13:15:00Z"))).toBe(true);
    expect(forceAllowed(null, Date.parse("2026-10-07T13:15:00Z"))).toBe(false);
    expect(realClockText(busy.forceAllowedAtReal)).toBe("10:15");
  });
});

describe("the upcoming events", () => {
  it("say what each timer is: the milestone of a deadline, the network of a settlement", () => {
    expect(timerLabel({ kind: "SLA", timerId: "cmp-l000001-OPERATOR_REMINDER", ownerKey: "CMP#cmp-l000001" })).toBe("Hito del plazo: recordatorio al operador (día hábil 5)");
    expect(timerLabel({ kind: "SETTLEMENT_PUBLISH", timerId: "NORTE-2026-10-07", ownerKey: "BATCH#NORTE#2026-10-07" })).toBe("Publicación de rendición (Red de cobro Norte)");
    expect(timerLabel({ kind: "AUTO_CLOSE", timerId: "cmp-h000116-AUTO_CLOSE", ownerKey: "CMP#cmp-h000116" })).toBe("Cierre automático");
    expect(timerLabel({ kind: "NEW_KIND", timerId: "x", ownerKey: null })).toBe("NEW_KIND");
  });
});

describe("the reset's refusals in words [FL-100] [FL-125]", () => {
  it("tells the 10-minute interval apart from the day's reset cap of a self-signup world, worded as the usage limit", () => {
    expect(clockCopy.refusals.RATE_LIMITED).toContain("10 minutos");
    expect(clockCopy.refusals.RESET_DAILY_CAP).toBe("Llegaste al límite de uso de hoy de este entorno. · You've reached today's usage limit for this environment.");
  });
});
