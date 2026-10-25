// The fixed reply to a number without a customer (FL-002) through the real gate: tape `ALLOWED` then
// `DISPATCH SENT` with `sender SYSTEM`, the party named only by the keyed hash, no Bedrock, a redelivery
// answered without a second send, and a live world that never reaches a number the lender does not know.
import { describe, expect, it } from "vitest";
import { WHATSAPP_TEXT } from "../copy";
import { call, gateRig, tapeOf } from "./testing";
import { type UnknownSenderReply, replyToUnknownSender, unknownPartyOf } from "./unknown-sender";

const PHONE_HASH = "4f".repeat(32);
const WA_ID = "5491100777001";

function reply(overrides: Partial<UnknownSenderReply> = {}): UnknownSenderReply {
  return { worldId: "demo", phoneHash: PHONE_HASH, waId: WA_ID, textKey: "UNKNOWN_SENDER", wamid: "wamid.SIM.unknown-0001", atSim: "2026-10-07T10:05:00-03:00", messageId: "wa-re-unknown-0001", ...overrides };
}

describe("a number that is not a customer [FL-002]", () => {
  it("[FL-002] gets the fixed UNKNOWN_SENDER text: ALLOWED then DISPATCH SENT, sender SYSTEM, without G2", async () => {
    const rig = await gateRig();
    const outcome = await replyToUnknownSender(rig.deps, reply(), call(rig));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED", messageId: "wa-re-unknown-0001" });
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => [entry.decision, entry.result ?? null, entry.sender, entry.kind])).toEqual([
      ["ALLOWED", null, "SYSTEM", "REPLY"],
      ["DISPATCH", "SENT", "SYSTEM", "REPLY"],
    ]);
    const serialized = JSON.stringify(tape);
    for (const secret of [WA_ID, PHONE_HASH, unknownPartyOf(PHONE_HASH)]) expect(serialized).not.toContain(secret);
    expect(rig.g2.inputs).toHaveLength(0);
    expect(rig.whatsappSent).toHaveLength(1);
    expect(rig.whatsappSent[0]?.record).toMatchObject({ customerId: unknownPartyOf(PHONE_HASH), to: `+${WA_ID}` });
    const thread = await rig.kit.connector.conversations.listMessages("demo", unknownPartyOf(PHONE_HASH));
    expect(thread.map((message) => [message.direction, message.body.includes(WHATSAPP_TEXT.UNKNOWN_SENDER)])).toEqual([
      ["IN", false],
      ["OUT", true],
    ]);
    // What the number wrote is never kept.
    expect(thread[0]?.body).toBe("");
  });

  it("[FL-002] a redelivery answers what was decided and never sends twice", async () => {
    const rig = await gateRig();
    await replyToUnknownSender(rig.deps, reply(), call(rig));
    const again = await replyToUnknownSender(rig.deps, reply(), call(rig));
    expect(again).toMatchObject({ ok: true, decision: "ALLOWED", messageId: "wa-re-unknown-0001" });
    expect(rig.whatsappSent).toHaveLength(1);
    expect(await tapeOf(rig)).toHaveLength(2);
  });

  it("[FL-002] in a live world no number resolves: the fence blocks it on the tape and nothing is sent", async () => {
    const rig = await gateRig();
    const settings = await rig.kit.connector.worlds.getSettings("demo");
    if (settings === undefined) throw new Error("no settings");
    await rig.kit.connector.worlds.putSettings({ ...settings, channelModes: { whatsapp: "live" } }, settings.version);
    const live = { ...rig.deps, stageModes: { email: "live" as const, whatsapp: { liveWorlds: ["demo"] } } };
    const outcome = await replyToUnknownSender(live, reply(), call(rig));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED" });
    expect((await tapeOf(rig)).map((entry) => entry.decision)).toEqual(["BLOCKED"]);
    expect(rig.whatsappSent).toHaveLength(0);
  });

  it("refuses any text but the ones a number without a customer may receive", async () => {
    const rig = await gateRig();
    await expect(replyToUnknownSender(rig.deps, { ...reply(), textKey: "OPT_OUT_CONFIRMATION" as never }, call(rig))).rejects.toThrow();
    expect(rig.whatsappSent).toHaveLength(0);
  });
});
