import { describe, expect, it } from "vitest";
import { bannerOf, offeredRoutes, openBlockOf, trailOf, trailStatus, type TapeEntryView } from "./gate-model";

let seq = 0;
function entry(overrides: Partial<TapeEntryView>): TapeEntryView {
  seq += 1;
  return {
    worldId: "demo",
    epoch: 1,
    seq,
    prevHash: "0".repeat(64),
    hash: "1".repeat(64),
    atSim: "2026-10-07T13:15:00.000Z",
    tapeId: `tp-${seq}`,
    decision: "ALLOWED",
    ruleIds: [],
    evaluated: [],
    ruleSetVersion: "ch-2026.10.06",
    sender: "OPERATOR:stf-operator-01",
    channel: "WHATSAPP",
    kind: "COLLECTION_REMINDER",
    ...overrides,
  } as TapeEntryView;
}

describe("gate trail of an operator's message [FL-064] [FL-065] [FL-066]", () => {
  const blocked = entry({ tapeId: "tp-block", decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], messageId: "opm-1" });
  const unrelated = entry({ tapeId: "tp-other", decision: "ALLOWED", messageId: "opm-9" });

  it("[FL-064] the block of the message waits for the person, with both permitted paths", () => {
    const trail = trailOf([unrelated, blocked], "opm-1");
    expect(trail.map((row) => row.tapeId)).toEqual(["tp-block"]);
    expect(trailStatus(trail)).toBe("NEEDS_CHOICE");
    expect(openBlockOf(trail)?.tapeId).toBe("tp-block");
    expect(offeredRoutes(blocked)).toEqual(["HUMAN_QUEUE", "FORMAL_EMAIL"]);
  });

  it("[FL-064] the banner is red with the rule, its reason and the English gloss", () => {
    const banner = bannerOf(blocked);
    expect(banner.tone).toBe("danger");
    expect(banner.es).toBe("BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de WhatsApp (cobro de deudas)");
    expect(banner.en).toBe("BLOCKED · CH-WA-NO-COLLECTION · WhatsApp Commerce Policy (debt collection)");
  });

  it("[FL-065] follows the formal email: REROUTED, the child's ALLOWED and its dispatch", () => {
    const rerouted = entry({ decision: "REROUTED", ruleIds: ["CH-WA-NO-COLLECTION"], messageId: "opm-1", rerouteOf: "tp-block", reroute: { route: "FORMAL_EMAIL", childTapeId: "tp-child" } });
    const child = entry({ tapeId: "tp-child", decision: "ALLOWED", channel: "EMAIL", kind: "COLLECTION_NOTICE_EMAIL", messageId: "rr-op-tp-block", rerouteOf: "tp-block" });
    const dispatch = entry({ decision: "DISPATCH", channel: "EMAIL", kind: "COLLECTION_NOTICE_EMAIL", messageId: "rr-op-tp-block", result: "SENT" });
    const partial = trailOf([unrelated, blocked, rerouted, child], "opm-1");
    expect(openBlockOf(partial)).toBeUndefined();
    expect(trailStatus(partial)).toBe("WAITING");
    const full = trailOf([dispatch, child, unrelated, rerouted, blocked], "opm-1");
    expect(full.map((row) => row.decision)).toEqual(["BLOCKED", "REROUTED", "ALLOWED", "DISPATCH"]);
    expect(trailStatus(full)).toBe("SETTLED");
    expect(offeredRoutes(child)).toEqual([]);
  });

  it("[FL-066] a reroute to the human queue settles the trail without a send", () => {
    const rerouted = entry({ decision: "REROUTED", ruleIds: ["CH-WA-NO-COLLECTION"], messageId: "opm-1", rerouteOf: "tp-block", reroute: { route: "HUMAN_QUEUE" } });
    expect(trailStatus(trailOf([blocked, rerouted], "opm-1"))).toBe("SETTLED");
  });

  it("[FL-085] an allowed message settles with its dispatch; the agent's block offers only the human queue", () => {
    const allowed = entry({ decision: "ALLOWED", kind: "OPERATOR_MESSAGE", messageId: "opm-2" });
    expect(trailStatus(trailOf([allowed], "opm-2"))).toBe("WAITING");
    expect(trailStatus(trailOf([allowed, entry({ decision: "DISPATCH", kind: "OPERATOR_MESSAGE", messageId: "opm-2", result: "SENT" })], "opm-2"))).toBe("SETTLED");
    expect(trailStatus([])).toBe("WAITING");
    expect(offeredRoutes({ ...blocked, sender: "AGENT" })).toEqual(["HUMAN_QUEUE"]);
  });
});
