import { GetWhatsAppMessageMediaCommand, type GetWhatsAppMessageMediaCommandInput, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_NOW, testConnector } from "../../connector/testing";
import { fixedClock } from "../../lib/clock";
import { MAX_MEDIA_BYTES } from "./config";
import { fetchLiveImage, imageOf, liveAnnounceKey, resolveSimulatedImage } from "./media";
import { worldStorageRoot } from "./media-keys";
import { parseEnvelope } from "./payloads";
import { MemoryBucket, eumMessage, fixture } from "./testing";

const eum = mockClient(SocialMessagingClient);
afterEach(() => eum.reset());

const WAMID = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjBDNzE0RTk4RjE4QzA0QjA1AA==";

/** End User Messaging Social as its API reference documents it: the object lands at `key + mediaId`. */
function serviceWrites(bucket: MemoryBucket, sizeBytes: number, seen: GetWhatsAppMessageMediaCommandInput[] = [], before?: () => Promise<void>) {
  eum.on(GetWhatsAppMessageMediaCommand).callsFake(async (input: GetWhatsAppMessageMediaCommandInput) => {
    await before?.();
    seen.push(input);
    bucket.put(`${input.destinationS3File?.key ?? ""}${input.mediaId ?? ""}`, sizeBytes, "image/jpeg");
    return { mimeType: "image/jpeg", fileSize: Math.ceil(sizeBytes / 1024) };
  });
}

function live() {
  const mc = testConnector();
  const bucket = new MemoryBucket();
  const deps = { phoneNumberId: "phone-number-id-0123456789abcdef0123456789abcdef", mediaBucketName: "reclamo-poc-media", bucket, data: mc.connector, realClock: fixedClock(TEST_NOW), client: new SocialMessagingClient({ region: "us-east-1" }), retry: { sleep: async () => undefined } };
  return { mc, bucket, deps };
}

describe("live media by prefix [FL-103]", () => {
  it("[FL-103] announces the prefix before the download, passes only the prefix as the key and records the real key", async () => {
    const { mc, bucket, deps } = live();
    const seen: GetWhatsAppMessageMediaCommandInput[] = [];
    const prefix = liveAnnounceKey("demo", WAMID);
    let announcedFirst = false;
    serviceWrites(bucket, 250_000, seen, async () => {
      announcedFirst = (await mc.connector.scans.get("demo", prefix)) !== undefined;
    });
    const outcome = await fetchLiveImage(deps, { worldId: "demo", wamid: WAMID, mediaId: "1555666777888999", contentType: "image/jpeg" });
    expect(announcedFirst).toBe(true);
    expect(seen[0]?.destinationS3File).toEqual({ bucketName: "reclamo-poc-media", key: `wa/demo/${WAMID}/` });
    expect(outcome).toEqual({ accepted: true, announceKey: prefix, s3Key: `wa/demo/${WAMID}/1555666777888999`, source: "WHATSAPP", contentType: "image/jpeg" });
    expect((await mc.connector.scans.get("demo", prefix))?.s3Key).toBe(`wa/demo/${WAMID}/1555666777888999`);
  });

  it("[FL-103] builds no key from the media id: two ids of different shapes share the prefix of their message", async () => {
    expect(liveAnnounceKey("demo", WAMID)).toBe(`wa/demo/${WAMID}/`);
    for (const mediaId of ["1555666777888999", "ABCdef123"]) {
      const { mc, bucket, deps } = live();
      serviceWrites(bucket, 1_000);
      const outcome = await fetchLiveImage(deps, { worldId: "demo", wamid: WAMID, mediaId, contentType: "image/jpeg" });
      expect(outcome).toMatchObject({ accepted: true, announceKey: `wa/demo/${WAMID}/`, s3Key: `wa/demo/${WAMID}/${mediaId}` });
      expect(await mc.connector.scans.get("demo", `wa/demo/${WAMID}/`)).toBeDefined();
    }
  });

  it("[FL-029] zero or two objects under the prefix end in IMAGE_NOT_PROCESSED (MEDIA_KEY_UNRESOLVED)", async () => {
    const none = live();
    eum.on(GetWhatsAppMessageMediaCommand).resolves({});
    expect(await fetchLiveImage(none.deps, { worldId: "demo", wamid: WAMID, mediaId: "123", contentType: "image/png" })).toEqual({ accepted: false, reply: "IMAGE_NOT_PROCESSED", reason: "MEDIA_KEY_UNRESOLVED" });
    eum.reset();
    const two = live();
    two.bucket.put(`wa/demo/${WAMID}/stale-object`, 10);
    serviceWrites(two.bucket, 1_000);
    expect(await fetchLiveImage(two.deps, { worldId: "demo", wamid: WAMID, mediaId: "123", contentType: "image/png" })).toMatchObject({ accepted: false, reason: "MEDIA_KEY_UNRESOLVED" });
    expect(two.bucket.objects.size).toBe(0);
  });

  it("[FL-029] deletes an image over 3.75 MB and asks for a lighter photo", async () => {
    const { bucket, deps } = live();
    serviceWrites(bucket, 4_500_000);
    expect(await fetchLiveImage(deps, { worldId: "demo", wamid: WAMID, mediaId: "123", contentType: "image/jpeg" })).toEqual({ accepted: false, reply: "MEDIA_TOO_LARGE", reason: "TOO_LARGE" });
    expect(bucket.objects.size).toBe(0);
  });
});

describe("simulated media [FL-029]", () => {
  const SIM_ID = `SIM${"ab".repeat(16)}`;
  async function sim(s3Key: string, contentType: "image/jpeg" | "image/png" = "image/png") {
    const mc = testConnector();
    const bucket = new MemoryBucket();
    await mc.connector.claims.putSimMedia({ worldId: "g07", simMediaId: SIM_ID, s3Key, contentType, createdAtReal: TEST_NOW.toISOString() });
    return { mc, bucket, deps: { bucket, data: mc.connector, realClock: fixedClock(TEST_NOW) } };
  }

  it("[FL-029] takes an upload of the world's own simulator, and refuses another world's key", async () => {
    const own = await sim("up/g07/msg-1/1.png");
    own.bucket.put("up/g07/msg-1/1.png", 80_000);
    expect(await resolveSimulatedImage(own.deps, { worldId: "g07", messageId: "wa-in-1", simMediaId: SIM_ID })).toEqual({ accepted: true, announceKey: "up/g07/msg-1/1.png", s3Key: "up/g07/msg-1/1.png", source: "SIMULATOR", contentType: "image/png" });
    const foreign = await sim("up/g08/msg-1/1.png");
    expect(await resolveSimulatedImage(foreign.deps, { worldId: "g07", messageId: "wa-in-1", simMediaId: SIM_ID })).toMatchObject({ accepted: false, reason: "FOREIGN_KEY" });
  });

  it("[FL-029] deletes an upload over the limit, and answers an unknown id with IMAGE_NOT_PROCESSED", async () => {
    const big = await sim("up/g07/msg-2/1.jpg", "image/jpeg");
    big.bucket.put("up/g07/msg-2/1.jpg", MAX_MEDIA_BYTES + 1);
    expect(await resolveSimulatedImage(big.deps, { worldId: "g07", messageId: "wa-in-2", simMediaId: SIM_ID })).toMatchObject({ accepted: false, reply: "MEDIA_TOO_LARGE" });
    expect(big.bucket.objects.size).toBe(0);
    expect(await resolveSimulatedImage(big.deps, { worldId: "g07", messageId: "wa-in-2", simMediaId: `SIM${"cd".repeat(16)}` })).toMatchObject({ accepted: false, reply: "IMAGE_NOT_PROCESSED", reason: "SIM_MEDIA_UNKNOWN" });
    expect(await resolveSimulatedImage(big.deps, { worldId: "g07", messageId: "wa-in-2", simMediaId: "1555666777888999" })).toMatchObject({ accepted: false, reason: "SIM_MEDIA_UNKNOWN" });
  });

  it("[FL-101] copies a seed receipt into the world's root after announcing the exact key", async () => {
    const seed = await sim("receipts/legible/C04-1.png");
    const outcome = await resolveSimulatedImage(seed.deps, { worldId: "g07", messageId: "wa-in-3", simMediaId: SIM_ID });
    expect(outcome).toEqual({ accepted: true, announceKey: "W/g07/sim/wa-in-3/0.png", s3Key: "W/g07/sim/wa-in-3/0.png", source: "SEED_COPY", contentType: "image/png" });
    expect(seed.bucket.copies).toEqual([{ seedKey: "receipts/legible/C04-1.png", mediaKey: "W/g07/sim/wa-in-3/0.png" }]);
    expect(await seed.mc.connector.scans.get("g07", "W/g07/sim/wa-in-3/0.png")).toMatchObject({ source: "SEED_COPY", s3Key: "W/g07/sim/wa-in-3/0.png" });
  });
});

describe("which media is read", () => {
  it("[FL-029] reads JPEG and PNG images only; PDFs, audio, stickers and other images get the fixed reply", () => {
    const image = parseEnvelope(eumMessage(fixture("entry-image.json", { FROM: "5491100009001", WAMID, MEDIA_ID: "1555666777888999", TEXT: "comprobante" }))).changes[0]?.messages[0];
    expect(image && imageOf(image)).toEqual({ id: "1555666777888999", contentType: "image/jpeg" });
    const audio = parseEnvelope(eumMessage(fixture("entry-audio.json", { FROM: "5491100009001", WAMID }))).changes[0]?.messages[0];
    expect(audio && imageOf(audio)).toBe("UNSUPPORTED");
    const base = { from: "5491100009001", id: WAMID, timestamp: "1791378900" };
    expect(imageOf({ ...base, type: "image", image: { id: "123", mime_type: "image/webp" } })).toBe("UNSUPPORTED");
    expect(imageOf({ ...base, type: "document", document: { id: "123", mime_type: "application/pdf" } })).toBe("UNSUPPORTED");
    expect(imageOf({ ...base, type: "text", text: { body: "hola" } })).toBeUndefined();
  });

  it("puts each world's objects under its own root", () => {
    expect(worldStorageRoot("demo")).toBe("W/demo/");
    expect(worldStorageRoot("gs-abcdefghij")).toBe("W/gs-abcdefghij/");
    expect(worldStorageRoot("qa-run1-sc03")).toBe("qa/run1/qa-run1-sc03/");
    expect(worldStorageRoot("qa-live-run1-sc23")).toBe("qa/run1/qa-live-run1-sc23/");
    expect(worldStorageRoot("qamin")).toBe("qa/qamin/");
  });
});
