import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addressHash } from "@reclamo/shared";
import { keys } from "../../../packages/bff/src/connector/keys";
import { signupRuntimeKeys } from "../../../packages/bff/src/leads/keys";
import { isVerified, loadRateCard } from "../../../packages/bff/src/metrics/assumptions";
import { WORLD_TEST_KEYS, worldsRig } from "../../../packages/bff/src/worlds/testing";
import { SEED_ROOT } from "../lib/constants";
import { parseLoadArgs } from "./args";
import { OverridesError } from "./overrides";
import { type LoadDeps, runSeedLoad } from "./run";

const DEMO_PHONE = "+5491177770000";

function loadRig(overrides: string | undefined = "{}") {
  const rig = worldsRig();
  const uploads: string[] = [];
  const deps: LoadDeps = { worlds: rig.deps, uploader: { put: async (key) => void uploads.push(key) }, overrides: () => overrides, root: SEED_ROOT };
  return { rig, uploads, deps };
}

async function auditEntries(rig: ReturnType<typeof worldsRig>, partition: string) {
  return (await rig.mc.store.query({ table: "AuditLog", partition })).items;
}

describe("seed:load", () => {
  it("opens the sign-up when SWITCH#SIGNUP is absent and audits SIGNUP_SWITCH_SEEDED", async () => {
    const { rig, deps } = loadRig();
    const summary = await runSeedLoad(deps, { force: false });
    expect(summary.signupSwitch).toBe("SEEDED");
    expect(await rig.mc.store.get("Runtime", signupRuntimeKeys.switch())).toMatchObject({ open: true });
    const audit = await auditEntries(rig, `SIGNUP#AUD#${rig.now().toISOString().slice(0, 7)}`);
    expect(audit.filter((entry) => entry.action === "SIGNUP_SWITCH_SEEDED")).toHaveLength(1);
  });

  it("keeps the switch an operator closed (`--off` survives every later deploy) and audits nothing", async () => {
    const { rig, deps } = loadRig();
    await rig.mc.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.switch(), entity: "SignupSwitch", open: false, changedAtReal: rig.now().toISOString() } });
    expect((await runSeedLoad(deps, { force: false })).signupSwitch).toBe("KEPT");
    expect(await rig.mc.store.get("Runtime", signupRuntimeKeys.switch())).toMatchObject({ open: false });
    const audit = await auditEntries(rig, `SIGNUP#AUD#${rig.now().toISOString().slice(0, 7)}`);
    expect(audit.filter((entry) => entry.action === "SIGNUP_SWITCH_SEEDED")).toHaveLength(0);
  });

  it("creates demo, qamin and gprobe READY with the factory; gprobe has nobody to sign in", async () => {
    const { rig, deps, uploads } = loadRig();
    const summary = await runSeedLoad(deps, { force: false });
    expect(summary.worlds).toEqual({ demo: "CREATED", qamin: "CREATED", gprobe: "CREATED" });
    for (const worldId of ["demo", "qamin", "gprobe"]) {
      expect(await rig.mc.connector.worlds.getMeta(worldId, { consistent: true })).toMatchObject({ status: "READY", epoch: 1 });
      expect((await rig.mc.connector.worlds.getSettings(worldId))?.channelModes.whatsapp).toBe("simulated");
    }
    expect(await rig.mc.connector.worlds.listStaff("gprobe")).toEqual([]);
    expect(uploads).toContain("worlds/guest.json");
    expect(uploads.some((key) => key.startsWith("receipts/legible/"))).toBe(true);
    expect(uploads.some((key) => key.startsWith("settlements/demo/"))).toBe(true);
    expect(uploads.some((key) => key.startsWith("evals/") || key === "reference.json")).toBe(false);
    expect((await rig.mc.connector.reference.list(z.looseObject({ date: z.string() }), "HOLIDAY", "AR")).length).toBeGreaterThan(10);
  });

  it("writes the verified rate card where the cost KPI reads it", async () => {
    const { rig, deps } = loadRig();
    await runSeedLoad(deps, { force: false });
    const card = await loadRateCard(rig.mc.connector);
    expect(card?.model).toBe("global.anthropic.claude-sonnet-5-5");
    expect(card && isVerified(card)).toBe(true);
  });

  it("is idempotent by fingerprint: a second load changes nothing, --force uploads again and resets the worlds", async () => {
    const { rig, deps, uploads } = loadRig();
    await runSeedLoad(deps, { force: false });
    const firstUploads = uploads.length;
    const again = await runSeedLoad(deps, { force: false });
    expect(again).toMatchObject({ changed: false, uploaded: 0, referenceRows: 0, worlds: { demo: "UNCHANGED", qamin: "UNCHANGED", gprobe: "UNCHANGED" } });
    expect(uploads).toHaveLength(firstUploads);

    const forced = await runSeedLoad(deps, { force: true });
    expect(forced).toMatchObject({ changed: true, worlds: { demo: "RESET", qamin: "RESET", gprobe: "RESET" } });
    expect(await rig.mc.connector.worlds.getMeta("demo", { consistent: true })).toMatchObject({ status: "READY", epoch: 2 });
  });

  it("keeps the status Meta gave a WhatsApp template when the reference is written again", async () => {
    const { rig, deps } = loadRig();
    await runSeedLoad(deps, { force: false });
    const key = keys.reference("TEMPLATE", "WHATSAPP", "reclamo_derivado");
    expect(await rig.mc.store.get("Reference", key)).toMatchObject({ status: "LOCAL_ONLY", category: "UTILITY", language: "es_AR" });
    await rig.mc.store.write({ kind: "update", table: "Reference", key, update: { set: { status: "APPROVED", metaTemplateId: "123" } } });
    await runSeedLoad(deps, { force: true });
    expect(await rig.mc.store.get("Reference", key)).toMatchObject({ status: "APPROVED", metaTemplateId: "123" });
  });

  it("refuses more than five demo recipients, or one outside @craftech.io, before writing anything", async () => {
    const six = JSON.stringify({ demoRecipients: { emails: Array.from({ length: 6 }, (_, index) => `persona.${index}@craftech.io`) } });
    const outside = JSON.stringify({ demoRecipients: { emails: ["alguien@example.org"] } });
    for (const raw of [six, outside]) {
      const { rig, deps } = loadRig(raw);
      const error = await runSeedLoad(deps, { force: false }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OverridesError);
      // The message names the rule, never an address.
      expect(String((error as Error).message)).not.toMatch(/@example\.org|persona\./);
      expect(await rig.mc.store.get("Runtime", signupRuntimeKeys.switch())).toBeUndefined();
      expect(await rig.mc.connector.worlds.getMeta("demo")).toBeUndefined();
    }
  });

  it("audits DEMO_RECIPIENTS_LOADED with how many and their keyed hashes, never an address", async () => {
    const { rig, deps } = loadRig(JSON.stringify({ demoRecipients: { emails: ["Nombre.Apellido@craftech.io", "otra.persona@craftech.io"] } }));
    expect((await runSeedLoad(deps, { force: false })).demoRecipients).toBe(2);
    const [entry] = await rig.mc.connector.audit.listByAction("demo", "DEMO_RECIPIENTS_LOADED");
    expect(entry).toMatchObject({ refs: { count: "2" }, detail: { count: 2 } });
    expect(JSON.stringify(entry)).not.toContain("@");
    expect((entry?.detail?.hashes as string[]).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  it("puts a persona's demo phone only in demo, with its LIVEPHONE# row", async () => {
    const { rig, deps } = loadRig(JSON.stringify({ personaPhones: { C01: DEMO_PHONE } }));
    expect((await runSeedLoad(deps, { force: false })).livePhones).toBe(1);
    const phoneHash = await addressHash("WHATSAPP", DEMO_PHONE, WORLD_TEST_KEYS.phoneHash);
    expect(await rig.mc.connector.claims.getLivePhone(phoneHash)).toMatchObject({ worldId: "demo" });
    expect(await rig.mc.store.get("Core", { pk: `W#demo#PHONE#${phoneHash}`, sk: "CLAIM" })).toBeDefined();
    expect(await rig.mc.store.get("Core", { pk: `W#qamin#PHONE#${phoneHash}`, sk: "CLAIM" })).toBeUndefined();
    // A reset of demo writes the phone again.
    await runSeedLoad(deps, { force: true });
    expect(await rig.mc.store.get("Core", { pk: `W#demo#PHONE#${phoneHash}`, sk: "CLAIM" })).toBeDefined();
  });

  it("takes only --force and --stage poc", () => {
    expect(parseLoadArgs([])).toEqual({ force: false });
    expect(parseLoadArgs(["--stage", "poc", "--force"])).toEqual({ force: true });
    expect(() => parseLoadArgs(["--stage", "prod"])).toThrow(RangeError);
    expect(() => parseLoadArgs(["--wipe"])).toThrow(RangeError);
  });
});
