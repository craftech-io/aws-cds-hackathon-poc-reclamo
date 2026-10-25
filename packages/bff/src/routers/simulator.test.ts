// `simulator.*` (FL-101, ADR-0002): the phone simulator builds the same signed SNS record a live
// WhatsApp event has and hands it to the REAL `InboundWhatsApp` pipeline (here in process): the
// signature and the console's key, the persona's phone, buttons by nonce, synthetic or uploaded
// receipts through `SIMMEDIA#`, the `SCANOBJ#` written before the presigned POST, and nothing at all
// while the world runs WhatsApp live.
import { beforeEach, describe, expect, it } from "vitest";
import { addressHash } from "@reclamo/shared";
import { SIM_ATTRIBUTES } from "../channels/whatsapp/config";
import { TEST_PHONE_KEY } from "../channels/whatsapp/testing";
import { message } from "../connector/testing";
import { personaPhone } from "./simulator";
import { type ConsoleRig, GUEST, OPERATOR, consoleRig, refusalOf } from "./testing";

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("g03");
});

function lastRecordAttributes() {
  const record = rig.delivered.at(-1)?.Records[0];
  return record?.Sns.MessageAttributes ?? {};
}

describe("simulator.personas [FL-101]", () => {
  it("[FL-101] lists the personas of the world with their script, masked phone and the unlinked number", async () => {
    const { caller } = await rig.as(GUEST);
    const { personas, unlinked } = await caller.simulator.personas();
    expect(personas.map((persona) => persona.persona)).toEqual(["C01", "C02", "C07", "C09"]);
    expect(personas[0]).toMatchObject({ customerId: "cus-0001", name: "Valeria Quiroga", hasReceipt: true, phoneMasked: "+54*******1001" });
    expect(personas[0]?.script[0]).toMatchObject({ receipt: true });
    expect(unlinked.persona).toBe("UNLINKED");
    expect(JSON.stringify(personas)).not.toContain("5491100001001");
  });
});

describe("simulator.sendText [FL-101]", () => {
  it("[FL-101] delivers a console-signed envelope from the persona's phone that InboundWhatsApp accepts", async () => {
    const { caller } = await rig.as(GUEST);
    const sent = await caller.simulator.sendText({ persona: "C01", text: "Pagué la cuota 4 y me sigue figurando atrasada" });
    expect(sent).toMatchObject({ persona: "C01", accepted: true, reason: null });
    expect(sent.wamid.startsWith("wamid.SIM.")).toBe(true);
    expect(lastRecordAttributes()[SIM_ATTRIBUTES.kid]?.Value).toBe("console");
    expect(lastRecordAttributes()[SIM_ATTRIBUTES.worldId]?.Value).toBe("g03");
    expect(rig.intake.intake).toHaveLength(1);
    expect(rig.intake.intake[0]).toMatchObject({ worldId: "g03", customerId: "cus-0001" });
  });

  it("[FL-002] sends from a number no customer of the world has", async () => {
    const { caller } = await rig.as(GUEST);
    const sent = await caller.simulator.sendText({ persona: "UNLINKED", text: "Hola, quiero hacer un reclamo por un pago" });
    expect(sent.accepted).toBe(true);
    expect(rig.intake.intake).toHaveLength(0);
  });

  it("[FL-101] answers WHATSAPP_LIVE for every procedure while the world runs WhatsApp live", async () => {
    await rig.seedWorld("demo", { mode: "live" });
    const { caller } = await rig.as(OPERATOR);
    expect(await refusalOf(() => caller.simulator.personas())).toBe("WHATSAPP_LIVE");
    expect(await refusalOf(() => caller.simulator.sendText({ persona: "C01", text: "hola" }))).toBe("WHATSAPP_LIVE");
    expect(await refusalOf(() => caller.simulator.presignReceipt({ persona: "C01", contentType: "image/png", sizeBytes: 10 }))).toBe("WHATSAPP_LIVE");
    expect(rig.delivered).toHaveLength(0);
  });
});

describe("simulator.tapButton and threads [FL-101]", () => {
  beforeEach(async () => {
    const phoneHash = await addressHash("WHATSAPP", personaPhone("C01"), TEST_PHONE_KEY);
    await rig.connector.write(rig.connector.claims.putNonceOp({ worldId: "g03", nonce: "nonce-accept-0001", action: "ACCEPT_EMAIL", phoneHash, customerId: "cus-0001", complaintId: "cmp-0001", createdAtReal: rig.now().toISOString() }));
    await rig.connector.conversations.putMessage(
      message("g03", {
        messageId: "msg-out-0001",
        direction: "OUT",
        body: "Tu reclamo es R-2026-000123.",
        status: "DELIVERED",
        providerMessageId: "wamid.SIM.01OUT",
        sender: "SYSTEM",
        interactive: { shape: "buttons", buttons: [{ action: "ACCEPT_EMAIL", nonce: "nonce-accept-0001", title: "Sí, a ese email" }, { action: "TALK_TO_HUMAN", nonce: "nonce-human-0001" }] },
      }),
    );
  });

  it("[FL-101] shows the thread as the phone does: buttons with titles, never a nonce", async () => {
    const { caller } = await rig.as(GUEST);
    const thread = await caller.simulator.threads({ persona: "C01" });
    expect(thread.messages.map((item) => item.messageId)).toEqual(["msg-out-0001"]);
    expect(thread.messages[0]?.buttons).toEqual([
      { index: 0, action: "ACCEPT_EMAIL", title: "Sí, a ese email" },
      { index: 1, action: "TALK_TO_HUMAN", title: "Hablar con alguien" },
    ]);
    expect(JSON.stringify(thread)).not.toContain("nonce-");
    expect(thread.typing).toBe(false);
    await rig.connector.write(rig.connector.runtime.addInFlightOp("g03", `cus-0001#evt-1@${rig.now().getTime()}`));
    expect((await caller.simulator.threads({ persona: "C01" })).typing).toBe(true);
  });

  it("[FL-101] taps a button: the nonce travels in the envelope and the intake resolves it for the persona", async () => {
    const { caller } = await rig.as(GUEST);
    const sent = await caller.simulator.tapButton({ persona: "C01", messageId: "msg-out-0001", buttonIndex: 0 });
    expect(sent.accepted).toBe(true);
    expect(rig.intake.effects).toEqual([expect.objectContaining({ kind: "EMAIL_CONSENT", input: expect.objectContaining({ accepted: true, customerId: "cus-0001" }) })]);
    expect(await refusalOf(() => caller.simulator.tapButton({ persona: "C01", messageId: "msg-out-0001", buttonIndex: 7 }))).toBe("SIM_BUTTON_NOT_FOUND");
  });

  it("[FL-101] marks the thread read", async () => {
    const { caller } = await rig.as(GUEST);
    expect(await caller.simulator.markRead({ persona: "C01" })).toEqual({ persona: "C01", marked: 1 });
  });
});

describe("simulator receipts [FL-101]", () => {
  it("[FL-101] attaches the persona's synthetic receipt: SIMMEDIA# names the seed object and InboundWhatsApp copies it into the world", async () => {
    const { caller } = await rig.as(GUEST);
    const sent = await caller.simulator.attachReceipt({ persona: "C01", source: { kind: "SCRIPT" } });
    expect(sent.accepted).toBe(true);
    expect(await rig.connector.claims.getSimMedia("g03", `SIM${"1".padStart(32, "0")}`)).toMatchObject({ s3Key: "receipts/legible/c01-1.png", contentType: "image/png" });
    expect(rig.bucket.copies).toEqual([{ seedKey: "receipts/legible/c01-1.png", mediaKey: expect.stringMatching(/^W\/g03\/sim\/.+\/0\.png$/) }]);
  });

  it("[FL-101] writes the SCANOBJ# of the upload key BEFORE signing the POST, under up/<worldId>/, ≤ 3.75 MB", async () => {
    const seenAtSigning: unknown[] = [];
    const ports = rig.deps.simulatorPorts;
    if (!ports) throw new Error("rig");
    Object.assign(ports, { presignUpload: async (key: string, contentType: string) => (seenAtSigning.push(await rig.connector.scans.get("g03", key)), { url: "https://media.test/", fields: { key, "Content-Type": contentType } }) });
    const { caller } = await rig.as(GUEST);
    const post = await caller.simulator.presignReceipt({ persona: "C01", contentType: "image/jpeg", sizeBytes: 3_932_160 });
    expect(post.key).toMatch(/^up\/g03\/up-[0-9a-z]{26}\/0\.jpg$/);
    expect(post).toMatchObject({ maxBytes: 3_932_160, expiresInSeconds: 300, fields: { key: post.key, "Content-Type": "image/jpeg" } });
    expect(seenAtSigning).toEqual([expect.objectContaining({ announceKey: post.key, s3Key: post.key, source: "SIMULATOR" })]);
    await expect(caller.simulator.presignReceipt({ persona: "C01", contentType: "image/png", sizeBytes: 3_932_161 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.simulator.presignReceipt({ persona: "C01", contentType: "image/gif" as never, sizeBytes: 10 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("[FL-101] sends an uploaded image only from its own announced key, and the intake binds it", async () => {
    const { caller } = await rig.as(GUEST);
    const post = await caller.simulator.presignReceipt({ persona: "C01", contentType: "image/png", sizeBytes: 120_000 });
    rig.bucket.put(post.key, 120_000, "image/png");
    const sent = await caller.simulator.attachReceipt({ persona: "C01", source: { kind: "UPLOAD", key: post.key } });
    expect(sent.accepted).toBe(true);
    expect(rig.intake.intake.at(-1)).toMatchObject({ customerId: "cus-0001" });
    expect(await refusalOf(() => caller.simulator.attachReceipt({ persona: "C01", source: { kind: "UPLOAD", key: "up/g04/up-01abcdefghjkmnpqrstvwxyz0/0.png" } }))).toBe("SIM_MEDIA_KEY");
    expect(await refusalOf(() => caller.simulator.attachReceipt({ persona: "C01", source: { kind: "UPLOAD", key: "up/g03/up-01abcdefghjkmnpqrstvwxyz0/0.png" } }))).toBe("SIM_MEDIA_KEY");
    expect(await refusalOf(() => caller.simulator.attachReceipt({ persona: "C02", source: { kind: "SCRIPT" } }))).toBe("SIM_NO_RECEIPT");
  });
});
