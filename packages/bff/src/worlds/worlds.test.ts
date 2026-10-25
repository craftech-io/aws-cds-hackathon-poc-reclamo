import { describe, expect, it } from "vitest";
import { addressHash } from "@reclamo/shared";
import { chainHash } from "../complaints/register";
import { keys } from "../connector/keys";
import { createWorld } from "./create";
import { UNLIMITED } from "./deps";
import { instantiate, settingsFor } from "./instantiate";
import { WORLD_TEST_KEYS, budgetOf, smallTemplate, worldsRig } from "./testing";
import { parseTemplate } from "./template";

const template = () => parseTemplate(smallTemplate("guest"), "guest");
const countOf = (entity: string) => template().items.filter((row) => row.entity === entity).length;

async function register(rig: ReturnType<typeof worldsRig>, worldId: string, kind: "GUEST" | "DEMO" | "QA" = "GUEST", templateName: "guest" | "demo" | "qa-min" = "guest") {
  await rig.mc.connector.worlds.register({ worldId, kind, template: templateName, epoch: 1, status: "REGISTERED" });
}

async function itemsOf(rig: ReturnType<typeof worldsRig>, table: "Core" | "Complaints" | "Timers" | "Conversations" | "Networks", worldId: string) {
  const out = [];
  let cursor: string | undefined;
  do {
    const page = await rig.mc.connector.worldItems.listKeys(table, worldId, { limit: 500, ...(cursor ? { cursor } : {}) });
    out.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

describe("create_world: REGISTERED → CREATING → READY [FL-100]", () => {
  it("[FL-100] builds a pre-registered world from its template, READY last, with its settings, clock and counters", async () => {
    const rig = worldsRig();
    await register(rig, "g01");
    const result = await createWorld(rig.deps, { worldId: "g01", budget: UNLIMITED });
    expect(result).toMatchObject({ status: "READY", created: true, epoch: 1 });

    const meta = await rig.mc.connector.worlds.getMeta("g01", { consistent: true });
    expect(meta).toMatchObject({ status: "READY", epoch: 1, template: "guest" });
    expect(meta?.buildCursor).toBeUndefined();
    expect(meta?.readyAtReal).toBe(rig.now().toISOString());
    expect(await rig.mc.connector.counters.getEpoch("g01")).toBe(1);
    const settings = await rig.mc.connector.worlds.getSettings("g01");
    expect(settings?.channelModes.whatsapp).toBe("simulated");
    expect(settings?.turnCaps).toEqual({ perDay: 150, perHour: 60 });
    const clock = await rig.mc.connector.runtime.getClock("g01");
    expect(clock).toMatchObject({ mode: "PAUSED", worldEpoch: 1, pausedSimNow: template().startAtSim });
    const audits = await rig.mc.connector.audit.listByAction("g01", "WORLD_CREATED");
    expect(audits).toHaveLength(1);
  });

  it("[FL-100] writes the template's manifest: every entity once, the chains and the anchors of THIS world", async () => {
    const rig = worldsRig();
    await register(rig, "g02");
    await createWorld(rig.deps, { worldId: "g02", budget: UNLIMITED });
    const core = await itemsOf(rig, "Core", "g02");
    // Every template row of Core plus one PHONE# claim per customer.
    expect(core).toHaveLength(template().items.filter((row) => row.table === "Core").length + countOf("Customer"));
    expect(await itemsOf(rig, "Complaints", "g02")).toHaveLength(template().items.filter((row) => row.table === "Complaints").length);
    expect(await itemsOf(rig, "Timers", "g02")).toHaveLength(countOf("Timer"));
    expect(await itemsOf(rig, "Conversations", "g02")).toHaveLength(countOf("ConversationMeta") + countOf("Message"));

    const head = await rig.mc.connector.chains.readHead("g02", 1, "REG");
    expect(head?.value).toBe(countOf("RegisterEntry"));
    const { entries } = await rig.mc.connector.chains.listRegister("REG", "g02", 1, { limit: 1_000 });
    let prevHash = "0".repeat(64);
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      expect(entry.prevHash).toBe(prevHash);
      expect(chainHash(WORLD_TEST_KEYS.chainKey, prevHash, rest)).toBe(hash);
      prevHash = hash;
    }
    expect((await rig.mc.connector.chains.readHead("g02", 1, "TAPE"))?.value).toBe(countOf("TapeEntry"));
    expect((await rig.mc.connector.chains.readHead("g02", 1, "RRI"))?.value).toBe(countOf("RefundEntry"));
    const anchored = rig.anchors.filter((request) => request.worldId === "g02" && request.chain === "REG").flatMap((request) => request.entries);
    expect(anchored).toHaveLength(countOf("RegisterEntry"));
    expect(await rig.mc.connector.audit.listByAction("g02", "APPROVAL_DECIDED")).toHaveLength(countOf("AuditEntry"));
    expect([...rig.objects.objects.keys()].every((key) => key.startsWith("Settlements/W/g02/"))).toBe(true);
    expect(rig.objects.objects.size).toBe(3);
  });

  it("[FL-100] hashes phones and emails with the stage key, claims every phone and keeps no clear contact data", async () => {
    const rig = worldsRig();
    await register(rig, "g03");
    await createWorld(rig.deps, { worldId: "g03", budget: UNLIMITED });
    const row = template().items.find((item) => item.entity === "Customer");
    const customerId = String(row?.data.customerId);
    const stored = await rig.mc.store.get("Core", { pk: `W#g03#CUS#${customerId}`, sk: "META" });
    const phoneHash = await addressHash("WHATSAPP", String(row?.data.phoneE164), WORLD_TEST_KEYS.phoneHash);
    expect(stored?.phoneHash).toBe(phoneHash);
    for (const clear of ["phoneE164", "email", "docNumber", "address"]) expect(stored).not.toHaveProperty(clear);
    expect(await rig.mc.store.get("Core", { pk: `W#g03#PHONE#${phoneHash}`, sk: "CLAIM" })).toMatchObject({ entity: "PhoneClaim", customerId });
    const tape = await rig.mc.connector.chains.listTapeBySeq("g03", 1);
    expect(tape.entries.every((entry) => entry.customerRef === undefined || /^[0-9a-f]{32}$/.test(entry.customerRef))).toBe(true);
  });

  it("[FL-100] refuses a world nobody pre-registered: a login never creates one", async () => {
    const rig = worldsRig();
    await expect(createWorld(rig.deps, { worldId: "g04", budget: UNLIMITED })).rejects.toMatchObject({ code: "NOT_FOUND", reason: "WORLD_NOT_REGISTERED" });
    expect(await rig.mc.connector.worlds.getMeta("g04")).toBeUndefined();
  });

  it("[FL-100] a run cut by its budget stays CREATING with its cursor and resumes without duplicates", async () => {
    const rig = worldsRig();
    await register(rig, "g05");
    const cut = await createWorld(rig.deps, { worldId: "g05", budget: budgetOf(4) });
    expect(cut.status).toBe("CREATING");
    const meta = await rig.mc.connector.worlds.getMeta("g05", { consistent: true });
    // SETTINGS, then three blocks of CORE: the fifth check finds no time left before CORE block 3.
    expect(meta).toMatchObject({ status: "CREATING", buildCursor: { phase: "CORE", block: 3 } });

    const resumed = await createWorld(rig.deps, { worldId: "g05", budget: UNLIMITED });
    expect(resumed).toMatchObject({ status: "READY", created: true });
    expect(await itemsOf(rig, "Core", "g05")).toHaveLength(template().items.filter((row) => row.table === "Core").length + countOf("Customer"));
    expect((await rig.mc.connector.chains.readHead("g05", 1, "REG"))?.value).toBe(countOf("RegisterEntry"));
  });

  it("[FL-100] stops with FACTORY_CONFLICT when an append-only entry of the world differs from the template", async () => {
    const rig = worldsRig();
    await register(rig, "g06");
    const build = await instantiate(template(), { worldId: "g06", epoch: 1, keys: WORLD_TEST_KEYS });
    const [first] = build.chains.REG;
    // Someone else's entry at seq 1 of this world and epoch, with another content and hash.
    await rig.mc.connector.chains.append({ chain: "REG", head: undefined, entry: { ...first, worldId: "g06", epoch: 1, seq: 1, prevHash: "0".repeat(64), hash: "f".repeat(64), reason: "otra cosa" } as never });
    await expect(createWorld(rig.deps, { worldId: "g06", budget: UNLIMITED })).rejects.toMatchObject({ code: "CONFLICT", reason: "FACTORY_CONFLICT" });
    expect((await rig.mc.connector.worlds.getMeta("g06", { consistent: true }))?.status).toBe("CREATING");
  });

  it("[FL-100] keeps an existing world READY untouched and keys every item under its own world", async () => {
    const rig = worldsRig();
    await register(rig, "g07");
    await createWorld(rig.deps, { worldId: "g07", budget: UNLIMITED });
    expect(await createWorld(rig.deps, { worldId: "g07", budget: UNLIMITED })).toMatchObject({ status: "READY", created: false });
    const keysOf = await itemsOf(rig, "Core", "g07");
    expect(keysOf.every((key) => key.pk.startsWith("W#g07#"))).toBe(true);
    expect(await rig.mc.store.get("Runtime", keys.counter("g07", "EPOCH"))).toMatchObject({ value: 1 });
  });
});

describe("instantiate: settings by origin, WhatsApp fence, demo phones [FL-100]", () => {
  it("[FL-100] gives a self-signup world the SIGNUP caps and an invited one the INVITED caps", () => {
    const doc = template();
    expect(settingsFor(doc, "gs-abcdefghij", 1)).toMatchObject({ worldId: "gs-abcdefghij", imageReadsPerDay: 20, turnCaps: { perDay: 60, perHour: 60 } });
    expect(settingsFor(doc, "g01", 1)).toMatchObject({ worldId: "g01", imageReadsPerDay: 60, turnCaps: { perDay: 150, perHour: 60 } });
  });

  it("[FL-100] keeps WhatsApp simulated in every world that may never run live, whatever the template says", () => {
    const doc = { ...template(), settings: { ...template().settings, channelModes: { whatsapp: "live" } } };
    expect(settingsFor(doc, "g01", 1)).toMatchObject({ channelModes: { whatsapp: "simulated" } });
    expect(settingsFor(doc, "gs-abcdefghij", 1)).toMatchObject({ channelModes: { whatsapp: "simulated" } });
    expect(settingsFor(doc, "demo", 1)).toMatchObject({ channelModes: { whatsapp: "live" } });
  });

  it("[FL-100] puts a persona's demo phone only in demo, with its own phone claim", async () => {
    const doc = template();
    const customerId = String(doc.items.find((row) => row.entity === "Customer")?.data.customerId);
    const build = await instantiate(doc, { worldId: "demo", epoch: 1, keys: WORLD_TEST_KEYS, livePhones: { [customerId]: "+5491177770000" } });
    const live = await addressHash("WHATSAPP", "+5491177770000", WORLD_TEST_KEYS.phoneHash);
    expect(build.core.find((item) => item.entity === "Customer" && item.customerId === customerId)).toMatchObject({ liveE164: "+5491177770000" });
    expect(build.core.some((item) => item.pk === `W#demo#PHONE#${live}`)).toBe(true);
    expect(build.livePhones).toEqual([{ phoneHash: live, customerId }]);
    await expect(instantiate(doc, { worldId: "g01", epoch: 1, keys: WORLD_TEST_KEYS, livePhones: { [customerId]: "+5491177770000" } })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
