// Step 5 of the gate (FL-073): the strict recipient fence decides before the tape says `ALLOWED`, so
// a refused recipient never reaches SES nor End User Messaging Social and the tape shows
// `BLOCKED CH-RECIPIENT-FENCE`. Every address is the SES mailbox simulator's or a reserved example.
import { describe, expect, it } from "vitest";
import { checkRecipientFence } from "../channels/email/recipient-fence";
import { createOutboundGate } from "./gate";
import { RECIPIENT_FENCE_RULE, emailFence, whatsappFence } from "./recipient-fence";
import { DEMO_PHONE, VALERIA, call, gateRig, request, seedComplaint, tapeOf } from "./testing";

const DEMO_EMAILS = ["demo.recipient@craftech.io"];
const strict = (worldId: string, to: string | undefined) => emailFence((intent) => checkRecipientFence(intent, () => DEMO_EMAILS), { worldId, to });
const STAGE_LIVE = { email: "live" as const, whatsapp: { liveWorlds: ["demo"] } };
const STAGE_SIMULATED = { email: "live" as const, whatsapp: { liveWorlds: [] } };

describe("recipient fence: email [FL-073]", () => {
  it.each([
    ["success+cus-0001@simulator.amazonses.com", "SIMULATOR"],
    ["bounce@simulator.amazonses.com", "SIMULATOR"],
    ["ooto+g07-cus-0004@simulator.amazonses.com", "SIMULATOR"],
  ])("lets %s reach the SES simulator [FL-073]", (to, target) => {
    expect(strict("g07", to)).toEqual({ allowed: true, target });
  });

  it.each([
    ["success@simulator.amazonses.com.example.net", "a look-alike suffix"],
    ["SUCCESS@simulator.amazonses.com", "upper case"],
    ["success@Simulator.amazonses.com", "an upper-case domain"],
    ["success@simulator.amazonses.com.", "a final dot"],
    ['"success"@simulator.amazonses.com', "quotes"],
    ["success@x@simulator.amazonses.com", "several @"],
    ["success@simulatör.amazonses.com", "an IDN"],
    ["success@simulator.amazonses.com\r\nBcc: someone@example.com", "CR/LF"],
    ["success+UPPER@simulator.amazonses.com", "an invalid +label"],
    ["success+label_with_underscore@simulator.amazonses.com", "an invalid +label"],
    ["someone@simulator.amazonses.com", "an unknown simulator mailbox"],
    ["ana@example.com", "a reserved domain"],
    ["ana@empresa-ficticia.test", "a reserved domain"],
    ["otra.casilla@craftech.io", "an inbox of the domain that is not a demo recipient"],
  ])("refuses %s (%s) [FL-073]", (to) => {
    const verdict = strict("demo", to);
    expect(verdict.allowed).toBe(false);
  });

  it("lets a demo recipient through only from the demo world [FL-073]", () => {
    expect(strict("demo", "demo.recipient@craftech.io")).toEqual({ allowed: true, target: "DEMO_RECIPIENT" });
    expect(strict("g07", "demo.recipient@craftech.io")).toEqual({ allowed: false, reason: "DEMO_RECIPIENT_OUTSIDE_DEMO" });
    expect(strict("gs-abcdefghij", "demo.recipient@craftech.io")).toEqual({ allowed: false, reason: "DEMO_RECIPIENT_OUTSIDE_DEMO" });
    expect(strict("qa-r1-sc14", "demo.recipient@craftech.io").allowed).toBe(false);
  });

  it("refuses an email without a recipient", () => {
    expect(strict("demo", undefined)).toEqual({ allowed: false, reason: "NO_RECIPIENT" });
  });
});

describe("recipient fence: WhatsApp [FL-073]", () => {
  it("a simulated world reaches the phone simulator only [FL-073]", () => {
    expect(whatsappFence({ worldId: "g07", mode: "simulated", to: undefined, demoPhones: [], stageModes: STAGE_SIMULATED })).toEqual({ allowed: true, target: "PHONE_SIMULATOR" });
  });

  it("live only from a world the stage lets run live, and only to a registered demo phone [FL-073]", () => {
    expect(whatsappFence({ worldId: "demo", mode: "live", to: "+54 9 11 0000-9999", demoPhones: [DEMO_PHONE], stageModes: STAGE_LIVE })).toEqual({ allowed: true, target: "DEMO_PHONE" });
    expect(whatsappFence({ worldId: "demo", mode: "live", to: "+5491100001001", demoPhones: [DEMO_PHONE], stageModes: STAGE_LIVE })).toEqual({ allowed: false, reason: "PHONE_NOT_REGISTERED" });
    expect(whatsappFence({ worldId: "demo", mode: "live", to: undefined, demoPhones: [DEMO_PHONE], stageModes: STAGE_LIVE })).toEqual({ allowed: false, reason: "NO_RECIPIENT" });
    expect(whatsappFence({ worldId: "demo", mode: "live", to: DEMO_PHONE, demoPhones: [DEMO_PHONE], stageModes: STAGE_SIMULATED })).toEqual({ allowed: false, reason: "WORLD_NEVER_LIVE" });
    expect(whatsappFence({ worldId: "g07", mode: "live", to: DEMO_PHONE, demoPhones: [DEMO_PHONE], stageModes: { email: "live", whatsapp: { liveWorlds: ["g07"] } } })).toEqual({ allowed: false, reason: "WORLD_NEVER_LIVE" });
  });
});

describe("recipient fence through the gate [FL-073]", () => {
  it("a recipient the policy's plain check lets through but the strict fence refuses: BLOCKED, nothing reaches SES [FL-073]", async () => {
    const rig = await gateRig();
    await seedComplaint(rig);
    // The policy sees the demo list; the SES client (the strict fence) has none: the strict one decides.
    const gate = createOutboundGate({ ...rig.deps, emails: { addressOf: async () => "demo.recipient@craftech.io" } });
    const outcome = await gate(request("ACK_EMAIL", { channel: "EMAIL", complaintId: "cmp-0001", text: "Registramos tu reclamo R-2026-000123." }), call(rig));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: [RECIPIENT_FENCE_RULE], failure: { error: { code: "RECIPIENT_NOT_ALLOWED" } } });
    expect(rig.email.sent).toEqual([]);
    expect(rig.email.trail).toEqual([]);
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => [entry.decision, entry.ruleIds])).toEqual([["BLOCKED", [RECIPIENT_FENCE_RULE]]]);
    expect(JSON.stringify(tape)).not.toContain("craftech.io");
    expect(JSON.stringify(rig.lines)).not.toContain("demo.recipient");
  });

  it("an address outside the simulator from a guest world is refused by the policy itself: BLOCKED, no SES call [FL-073]", async () => {
    const rig = await gateRig({ worldId: "g07" });
    await seedComplaint(rig);
    const gate = createOutboundGate({ ...rig.deps, emails: { addressOf: async () => "success@simulator.amazonses.com.example.net" } });
    const outcome = await gate(request("ACK_EMAIL", { worldId: "g07", channel: "EMAIL", complaintId: "cmp-0001", text: "Registramos tu reclamo R-2026-000123." }), call(rig));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: [RECIPIENT_FENCE_RULE] });
    expect(rig.email.sent).toEqual([]);
  });

  it("the customer's own simulator mailbox goes out with one recipient, the same in Destination and in the MIME [FL-073]", async () => {
    const rig = await gateRig({ worldId: "g07" });
    await seedComplaint(rig);
    const outcome = await rig.gate(request("ACK_EMAIL", { worldId: "g07", channel: "EMAIL", complaintId: "cmp-0001", text: "Registramos tu reclamo R-2026-000123." }), call(rig));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(rig.email.sent).toHaveLength(1);
    expect(rig.email.sent[0]?.Destination).toEqual({ ToAddresses: [`success+g07-${VALERIA}@simulator.amazonses.com`] });
  });
});
