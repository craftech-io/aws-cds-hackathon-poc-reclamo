import { describe, expect, it } from "vitest";
import { BUTTON_TITLES } from "../../copy";
import { TEST_NOW } from "../../connector/testing";
import { processWhatsAppEvent } from "./inbound";
import { issueNonces } from "./nonces";
import { BAJA_CHOICE, foldKeyword, keywordIntent } from "./opt-out";
import { inboundRig, seedWorld, simEvent, testPhoneHash } from "./testing";

describe("opt-out keywords and the ambiguous 'baja' [FL-006]", () => {
  it("[FL-006] recognizes the opt-out words however they are written, and nothing longer", () => {
    for (const text of ["STOP", "stop", "¡Stop!", "NO RECIBIR", "no recibir", "No recibir mensajes", "no quiero recibir más mensajes"]) expect(keywordIntent(text), text).toBe("OPT_OUT");
    for (const text of ["stop, pero antes decime mi saldo", "no recibí la transferencia", "quiero dar de baja mi cuenta"]) expect(keywordIntent(text), text).toBeUndefined();
    expect(foldKeyword("  ¡NO   RECIBÍR!  ")).toBe("no recibir");
  });

  it("[FL-006] reads 'baja' alone as ambiguous and offers the two buttons", () => {
    expect(keywordIntent("baja")).toBe("BAJA_AMBIGUOUS");
    expect(keywordIntent("BAJA.")).toBe("BAJA_AMBIGUOUS");
    expect(BAJA_CHOICE.map((button) => button.action)).toEqual(["OPT_OUT", "CONFIRM_CLOSURE"]);
    expect([BUTTON_TITLES.OPT_OUT.INTERACTIVE, BUTTON_TITLES.CONFIRM_CLOSURE.INTERACTIVE]).toEqual(["No recibir mensajes", "Baja de mi cuenta"]);
  });
});

describe("opt-out through the adapter [FL-006]", () => {
  async function rig() {
    const phoneHash = await testPhoneHash();
    const r = inboundRig({ customers: { [`g07#${phoneHash}`]: "cus-0038" } });
    await seedWorld(r.mc, "g07");
    return { ...r, phoneHash };
  }

  it("[FL-006] 'STOP' opts out without the model and confirms with the fixed text", async () => {
    const r = await rig();
    const summary = await processWhatsAppEvent(simEvent("g07", { type: "text", text: "STOP" }), r.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("OPTED_OUT");
    expect(r.recorded.effects).toEqual([{ kind: "OPT_OUT", input: expect.objectContaining({ customerId: "cus-0038", via: "KEYWORD" }) }]);
    expect(r.recorded.replies).toEqual([expect.objectContaining({ kind: "OPT_OUT_CONFIRMATION", textKey: "OPT_OUT_CONFIRMATION", customerId: "cus-0038" })]);
    expect(r.recorded.intake).toHaveLength(0);
  });

  it("[FL-006] the opt-out button does the same, and 'baja' alone never closes anything", async () => {
    const r = await rig();
    const [optOut = ""] = await issueNonces(r.mc.connector, { worldId: "g07", customerId: "cus-0038", phoneHash: r.phoneHash, messageId: "msg-out-2", buttons: [{ action: "OPT_OUT" }], now: TEST_NOW });
    await processWhatsAppEvent(simEvent("g07", { type: "button_reply", nonce: optOut, title: "No recibir mensajes" }), r.deps);
    expect(r.recorded.effects).toEqual([{ kind: "OPT_OUT", input: expect.objectContaining({ via: "BUTTON" }) }]);
    const summary = await processWhatsAppEvent(simEvent("g07", { type: "text", text: "baja" }, "wamid.SIM.01K6ZT0000000000000000000C"), r.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("BAJA_CHOICE");
    expect(r.recorded.replies.at(-1)).toMatchObject({ textKey: "BAJA_AMBIGUOUS", buttons: BAJA_CHOICE });
    expect(r.recorded.effects).toHaveLength(1);
    expect(r.recorded.intake).toHaveLength(0);
  });

  it("a sentence about closing the account goes to the intake, which registers it", async () => {
    const r = await rig();
    await processWhatsAppEvent(simEvent("g07", { type: "text", text: "quiero dar de baja mi cuenta" }), r.deps);
    expect(r.recorded.intake[0]?.text.text).toBe("quiero dar de baja mi cuenta");
    expect(r.recorded.effects).toHaveLength(0);
  });
});
