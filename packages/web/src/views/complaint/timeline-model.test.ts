import { describe, expect, it } from "vitest";
import type { TimelineItem } from "./api";
import { actorKindOf, isOpenOperatorBlock, itemKey, lexiconLabels, reroutedBlocks, shortHash, type TapeItem } from "./timeline-model";

function tape(overrides: Partial<TapeItem>): TapeItem {
  return {
    type: "TAPE",
    atSim: "2026-10-07T13:20:00.000Z",
    tapeId: "tp-1",
    seq: 1,
    decision: "BLOCKED",
    result: null,
    ruleIds: ["CH-WA-NO-COLLECTION"],
    sender: "OPERATOR:stf-operator-01",
    channel: "WHATSAPP",
    kind: "REPLY",
    messageId: "opm-1",
    payloadHash: null,
    reroute: null,
    rerouteOf: null,
    nextAllowedAt: null,
    ...overrides,
  } as TapeItem;
}

describe("case timeline [FL-067] [FL-084] [FL-085]", () => {
  it("[FL-067] a person's free text with collection content shows the lexicon's categories", () => {
    expect(lexiconLabels("Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos")).toEqual(expect.arrayContaining(["Exhortación de pago", "Amenaza de consecuencias"]));
    expect(lexiconLabels("Tu reclamo sigue en curso; te escribimos apenas tengamos novedades.")).toEqual([]);
  });

  it("[FL-067] a person's block stays open to reroute until its REROUTED lands", () => {
    const block = tape({});
    const items: TimelineItem[] = [block];
    expect(isOpenOperatorBlock(block, reroutedBlocks(items))).toBe(true);
    const answered = reroutedBlocks([...items, tape({ tapeId: "tp-2", decision: "REROUTED", rerouteOf: "tp-1" })]);
    expect(isOpenOperatorBlock(block, answered)).toBe(false);
    expect(isOpenOperatorBlock(tape({ sender: "AGENT" }), new Set())).toBe(false);
    expect(isOpenOperatorBlock(tape({ rerouteOf: "tp-0" }), new Set())).toBe(false);
  });

  it("[FL-084] never prints a staff id: actors are classes", () => {
    expect(actorKindOf("OPERATOR:stf-operator-01")).toBe("PERSON");
    expect(actorKindOf("AGENT")).toBe("AGENT");
    expect(actorKindOf(null)).toBe("SYSTEM");
    expect(actorKindOf(null, "IN")).toBe("CUSTOMER");
  });

  it("[FL-085] keys are unique per item and hashes are shortened for the screen", () => {
    const keys = [tape({}), tape({ tapeId: "tp-2" })].map(itemKey);
    expect(new Set(keys).size).toBe(2);
    expect(shortHash("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
  });
});
