import { describe, expect, it } from "vitest";
import { TEST_NOW } from "../../connector/testing";
import { buildSimulatedEvent } from "./sim-envelope";
import { checkRecordOrigin, transportFor, worldModeRejection, worldWhatsAppMode } from "./registry";
import { TEST_SIM_KEYS, TEST_TOPIC_ARN, eumMessage, fixture, liveRecord, onlyRecord, testSnsVerifier } from "./testing";
import type { WhatsAppTransport } from "./transport";

const live = { channelModes: { whatsapp: "live" as const } };
const simulated = { channelModes: { whatsapp: "simulated" as const } };
const stage = (liveWorlds: string[]) => ({ email: "live" as const, whatsapp: { liveWorlds } });

const transport = (mode: "live" | "simulated"): WhatsAppTransport => ({ mode, send: async () => Promise.reject(new Error("not in this test")) });

describe("mode per world [FL-104]", () => {
  it("[FL-104] is live only when the world says live and the stage lists it", () => {
    expect(worldWhatsAppMode("demo", live, stage(["demo"]))).toBe("live");
    expect(worldWhatsAppMode("demo", live, stage([]))).toBe("simulated");
    expect(worldWhatsAppMode("demo", simulated, stage(["demo"]))).toBe("simulated");
    expect(worldWhatsAppMode("demo", undefined, stage(["demo"]))).toBe("simulated");
    expect(worldWhatsAppMode("qa-live-run1-sc23", live, stage(["qa-live-*"]))).toBe("live");
  });

  it("[FL-104] keeps guest, QA and load worlds simulated even when their settings say live", () => {
    const everything = stage(["demo", "qa-live-*", "g07", "gs-abcdefghij", "qa-run1-sc22a", "sim-batch1"]);
    for (const worldId of ["g07", "gtest", "gprobe", "gs-abcdefghij", "qa-run1-sc22a", "qamin", "sim-batch1"]) {
      expect(worldWhatsAppMode(worldId, live, everything), worldId).toBe("simulated");
    }
  });

  it("[FL-104] picks the transport of the mode and never falls back from live to simulated", () => {
    const transports = { simulated: transport("simulated") };
    expect(transportFor(transports, "simulated").mode).toBe("simulated");
    expect(() => transportFor(transports, "live")).toThrow(/not configured/);
    expect(transportFor({ ...transports, live: transport("live") }, "live").mode).toBe("live");
    expect(() => transportFor({ simulated: transport("live") }, "simulated")).toThrow(/answered for simulated/);
  });

  it("[FL-104] lets a record enter a world only through the world's mode", () => {
    expect(worldModeRejection("SIMULATED", "live")).toBe("SIM_IN_LIVE_WORLD");
    expect(worldModeRejection("LIVE", "simulated")).toBe("LIVE_IN_SIMULATED_WORLD");
    expect(worldModeRejection("SIMULATED", "simulated")).toBeUndefined();
    expect(worldModeRejection("LIVE", "live")).toBeUndefined();
  });
});

describe("origin of a record", () => {
  const expectations = () => ({ topicArn: TEST_TOPIC_ARN, sns: testSnsVerifier().verifier, simKeys: TEST_SIM_KEYS, now: TEST_NOW });
  const entry = fixture("entry-text.json", { FROM: "5491100009001", WAMID: "wamid.LIVE2", TEXT: "hola" });

  it("[FL-103] accepts a signed live record of the app's account", async () => {
    const origin = await checkRecordOrigin(liveRecord(eumMessage(entry)), expectations());
    expect(origin).toMatchObject({ accepted: true, origin: "LIVE" });
  });

  it("[FL-104] refuses a live record of another account or with traces of the simulator", async () => {
    expect(await checkRecordOrigin(liveRecord(eumMessage(entry, { aws_account_id: "111122223333" })), expectations())).toMatchObject({ accepted: false, reason: "ACCOUNT_MISMATCH" });
    const simulatedEntry = fixture("entry-text.json", { FROM: "5491100009001", WAMID: "wamid.SIM.FORGED", TEXT: "hola" });
    expect(await checkRecordOrigin(liveRecord(eumMessage(simulatedEntry)), expectations())).toMatchObject({ accepted: false, reason: "SIM_MARKERS_IN_LIVE" });
    expect(await checkRecordOrigin(liveRecord("{not json"), expectations())).toMatchObject({ accepted: false, reason: "PAYLOAD_INVALID" });
  });

  it("[FL-104] accepts a signed simulated envelope and names its world", async () => {
    const event = buildSimulatedEvent(TEST_SIM_KEYS.console, { kid: "console", worldId: "g07", from: "+5491100001007", wamid: "wamid.SIM.01K6ZT00000000000000000001", content: { type: "text", text: "hola" }, at: TEST_NOW });
    expect(await checkRecordOrigin(onlyRecord(event), expectations())).toMatchObject({ accepted: true, origin: "SIMULATED", kid: "console", worldId: "g07" });
  });
});
