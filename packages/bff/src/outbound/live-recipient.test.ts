// The live number of WhatsApp `live` (docs/architecture-integrations.md §3.1, FL-073): the deployed gate
// and the live transport resolve it from the core's `liveE164` (`coreRecipients`), never from the
// persona directory, and only a world the stage lets run live asks for it. The gate's recipient fence
// and the transport still allow only the demo phones of `SeedOverrides.demoRecipients.phones`.
import type { SendWhatsAppMessageInput } from "@aws-sdk/client-socialmessaging";
import { describe, expect, it } from "vitest";
import { liveWhatsAppTransport } from "../channels/whatsapp/live-transport";
import { worldSettings } from "../connector/testing";
import type { CoreClient } from "../core/client";
import { coreRecipients } from "./directory";
import { createOutboundGate } from "./gate";
import { whatsappFence } from "./recipient-fence";
import { DEMO_PHONE, VALERIA, call, customerWrote, gateRig, request, tapeOf } from "./testing";

const LIVE_STAGE = { email: "live" as const, whatsapp: { liveWorlds: ["demo"] } };

/** A core that answers the live recipient with `e164` and records who asked. */
function liveCore(e164: string | undefined): CoreClient & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async call(operation: string, ctx: { worldId: string }, input: { params: { customerId: string } }) {
      if (operation !== "getLiveRecipient") throw new Error(`unexpected core call ${operation}`);
      asked.push(`${ctx.worldId}/${input.params.customerId}`);
      return { customerId: input.params.customerId, ...(e164 === undefined ? {} : { e164 }) };
    },
  } as unknown as CoreClient & { readonly asked: string[] };
}

async function liveRig(e164: string | undefined) {
  const rig = await gateRig();
  await rig.kit.connector.worlds.putSettings({ ...worldSettings("demo"), channelModes: { whatsapp: "live" } }, 1);
  const core = liveCore(e164);
  const recipients = coreRecipients({ core, simNow: async () => new Date(rig.simNow), stageModes: LIVE_STAGE });
  const sent: SendWhatsAppMessageInput[] = [];
  const live = liveWhatsAppTransport({
    phoneNumberId: "phone-number-id-0001",
    allowedPhones: rig.deps.demoRecipients().phones,
    isLiveWorld: async (worldId) => worldId === "demo",
    recipients,
    templates: { status: async () => "APPROVED" },
    eum: { send: async (input) => (sent.push(input), { messageId: `wamid.LIVE.${sent.length}` }) },
    realClock: { now: async () => new Date(rig.simNow) },
  });
  const deps = { ...rig.deps, recipients, stageModes: LIVE_STAGE, whatsapp: { ...rig.deps.whatsapp, live } };
  return { rig, gate: createOutboundGate(deps), core, sent, recipients };
}

describe("live WhatsApp resolves the core's live number [FL-073]", () => {
  it("a live world and a registered demo phone: ALLOWED, and the live transport writes to that number", async () => {
    const { rig, gate, core, sent } = await liveRig(DEMO_PHONE);
    await customerWrote(rig, VALERIA, "2026-10-07T10:05:00-03:00");
    const outcome = await gate(request("REPLY", { text: "Recibimos tu mensaje, ya lo estamos revisando." }), call(rig));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(core.asked.length).toBeGreaterThan(0);
    expect(core.asked.every((asked) => asked === `demo/${VALERIA}`)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.message as Uint8Array)).to).toBe(DEMO_PHONE);
    expect(rig.whatsappSent).toEqual([]);
  });

  it("a live number that is not a registered demo phone: BLOCKED CH-RECIPIENT-FENCE PHONE_NOT_REGISTERED, nothing sent", async () => {
    const { rig, gate, sent, recipients } = await liveRig("+5491100005555");
    await customerWrote(rig, VALERIA, "2026-10-07T10:05:00-03:00");
    const outcome = await gate(request("REPLY", { text: "Recibimos tu mensaje, ya lo estamos revisando." }), call(rig));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-RECIPIENT-FENCE"], failure: { error: { code: "RECIPIENT_NOT_ALLOWED" } } });
    const to = await recipients.whatsAppNumber("demo", VALERIA, "live");
    expect(whatsappFence({ worldId: "demo", mode: "live", to, demoPhones: rig.deps.demoRecipients().phones, stageModes: LIVE_STAGE })).toEqual({ allowed: false, reason: "PHONE_NOT_REGISTERED" });
    expect(sent).toEqual([]);
    expect((await tapeOf(rig)).map((entry) => entry.decision)).toEqual(["BLOCKED"]);
  });

  it("asks the core only for a world the stage lets run live; the phone simulator keeps the persona's number", async () => {
    const core = liveCore(DEMO_PHONE);
    const recipients = coreRecipients({ core, simNow: async () => new Date("2026-10-07T13:10:00.000Z"), stageModes: LIVE_STAGE });
    expect(await recipients.whatsAppNumber("g07", VALERIA, "live")).toBeUndefined();
    expect(await recipients.whatsAppNumber("demo", VALERIA, "simulated")).toBe("+5491100001001");
    expect(core.asked).toEqual([]);
    expect(await recipients.whatsAppNumber("demo", VALERIA, "live")).toBe(DEMO_PHONE);
  });
});
