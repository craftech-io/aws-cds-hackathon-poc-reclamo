import { describe, expect, it } from "vitest";
import { ALL, NO_FILTER, bannerOf, blockSourceOf, complaintFilterOf, listInputOf, reviewedRules, rowOf, senderText, type TapeItem } from "./tape-model";

function entry(overrides: Partial<TapeItem>): TapeItem {
  return {
    worldId: "demo",
    epoch: 1,
    seq: 43,
    prevHash: "a",
    hash: "b",
    atSim: "2026-10-07T13:10:00.000Z",
    atReal: "2026-10-09T19:28:07.041Z",
    createdAt: "2026-10-09T19:28:07.042Z",
    updatedAt: "2026-10-09T19:28:07.042Z",
    tapeId: "tp-l000002",
    decision: "ALLOWED",
    ruleIds: [],
    evaluated: [],
    ruleSetVersion: "ch-2026.10.06",
    sender: "AGENT",
    channel: "WHATSAPP",
    kind: "REPLY",
    ...overrides,
  } as TapeItem;
}

describe("a collection reminder an operator tried on WhatsApp [FL-064]", () => {
  const blocked = entry({
    decision: "BLOCKED",
    sender: "OPERATOR:stf-operator-01",
    kind: "COLLECTION_REMINDER",
    ruleIds: ["CH-WA-NO-COLLECTION"],
    evaluated: [
      { ruleId: "CH-SENDER", result: "PASS" },
      { ruleId: "CH-CONTROL", result: "SKIP" },
      { ruleId: "CH-WA-NO-COLLECTION", result: "BLOCK" },
    ],
  });

  it("reads as a red block with the rule's name and its English gloss", () => {
    expect(blockSourceOf(blocked)).toBe("CH-WA-NO-COLLECTION");
    expect(bannerOf(blocked)).toEqual({
      es: "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de WhatsApp (cobro de deudas)",
      en: "BLOCKED · CH-WA-NO-COLLECTION · WhatsApp Commerce Policy (debt collection)",
    });
  });

  it("names the person by staff id and the message kind in words", () => {
    expect(senderText(blocked.sender)).toBe("Persona del equipo · Staff · stf-operator-01");
    expect(rowOf(blocked)).toMatchObject({ decision: "BLOCKED", sender: "Persona del equipo · Staff · stf-operator-01", kind: "Recordatorio de mora", ruleIds: ["CH-WA-NO-COLLECTION"], atText: "mié 07/10 10:10" });
  });

  it("lists the rule that blocked first, then the ones that passed or did not apply", () => {
    expect(reviewedRules(blocked).map((rule) => `${rule.ruleId}:${rule.text}`)).toEqual(["CH-WA-NO-COLLECTION:bloquea", "CH-SENDER:pasó", "CH-CONTROL:no aplica"]);
  });
});

describe("tape decisions without a block [FL-075]", () => {
  it("show no banner and no rule chips when every rule passed", () => {
    const allowed = entry({ ruleIds: ["CH-SENDER", "CH-CONTROL"] });
    expect(bannerOf(allowed)).toBeUndefined();
    expect(bannerOf(entry({ decision: "DISPATCH", result: "SENT" }))).toBeUndefined();
    expect(rowOf(allowed).ruleIds).toEqual([]);
    expect(senderText("AGENT")).toBe("Agente · Agent");
    expect(senderText("SYSTEM")).toBe("Sistema · System");
  });

  it("a reroute and a deferral carry their own banner", () => {
    expect(bannerOf(entry({ decision: "REROUTED", ruleIds: ["CH-WA-NO-COLLECTION"] }))?.es).toBe("REENCAMINADO · REROUTED");
    expect(bannerOf(entry({ decision: "DEFERRED", ruleIds: ["CH-CONTACT-HOURS"] }))?.es).toBe("DIFERIDO · DEFERRED · CH-CONTACT-HOURS · Fuera del horario de contacto");
  });
});

describe("tape filters", () => {
  it("send only what is set, plus the page size", () => {
    expect(listInputOf(NO_FILTER)).toEqual({ limit: 100 });
    expect(listInputOf({ decision: "BLOCKED", sender: "OPERATOR", channel: "WHATSAPP", ruleId: "CH-WA-NO-COLLECTION", complaintId: "cmp-0009" }, 200)).toEqual({
      decision: "BLOCKED",
      sender: "OPERATOR",
      channel: "WHATSAPP",
      ruleId: "CH-WA-NO-COLLECTION",
      complaintId: "cmp-0009",
      limit: 200,
    });
    expect(listInputOf({ ...NO_FILTER, channel: ALL })).toEqual({ limit: 100 });
  });

  it("take a complaint from the link only when it looks like an id", () => {
    expect(complaintFilterOf(new URLSearchParams("complaint=cmp-0009"))).toBe("cmp-0009");
    expect(complaintFilterOf(new URLSearchParams("complaint=<script>"))).toBeUndefined();
    expect(complaintFilterOf(new URLSearchParams(""))).toBeUndefined();
  });
});
