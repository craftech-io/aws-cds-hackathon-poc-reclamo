// `policy.*` (docs/design-brief.md §7, §9; ADR-0002, ADR-0017): the rules with their text, gloss and the
// world's parameters, the channel modes of the world, and the agent's cut switch for a SUPERVISOR of demo.
import { beforeEach, describe, expect, it } from "vitest";
import { BlockSource } from "../copy";
import { RULE_SET_VERSION } from "../channel-policy/kinds";
import { COMPLIANCE, type ConsoleRig, GUEST, GUEST_SUPERVISOR, OPERATOR, SUPERVISOR, consoleRig, refusalOf } from "./testing";

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("demo", { mode: "live" });
  await rig.seedWorld("g03");
});

describe("policy.rules", () => {
  it("lists every rule with its text, English gloss and the parameters of the principal's world, as our reading", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const rules = await caller.policy.rules();
    expect(rules.ruleSetVersion).toBe(RULE_SET_VERSION);
    expect(rules.rules.map((rule) => rule.ruleId)).toEqual(BlockSource.options);
    const collection = rules.rules.find((rule) => rule.ruleId === "CH-WA-NO-COLLECTION");
    expect(collection?.short.length).toBeGreaterThan(0);
    expect(collection?.gloss.short.length).toBeGreaterThan(0);
    expect(rules.notLegalAdvice.es).toContain("no asesoramiento legal");
    expect(rules.parameters).toMatchObject({ maxProactivePerDay: 3, rateLimitPerHour: 20, channelModes: { whatsapp: "live" } });
  });
});

describe("policy.modes [FL-104]", () => {
  it("[FL-104] answers WhatsApp live only where the world says so and the stage allows it; a guest world stays simulated", async () => {
    const demo = (await rig.as(OPERATOR)).caller;
    expect(await demo.policy.modes()).toMatchObject({ email: "live", whatsapp: "live", whatsappConfigured: "live", stageAllowsLiveWhatsApp: true, agentKill: { global: false, world: false } });
    const settings = await rig.connector.worlds.getSettings("g03");
    if (!settings) throw new Error("seed");
    await rig.connector.worlds.putSettings({ ...settings, channelModes: { whatsapp: "live" } }, settings.version);
    const guest = (await rig.as(GUEST)).caller;
    expect(await guest.policy.modes()).toMatchObject({ whatsapp: "simulated", whatsappConfigured: "live", stageAllowsLiveWhatsApp: false });
  });
});

describe("policy.setAgentKill [FL-109]", () => {
  it("[FL-109] lets a SUPERVISOR of demo with a recent sign-in cut the agent everywhere and lift it, audited", async () => {
    const { caller } = await rig.as(SUPERVISOR);
    expect(await caller.policy.setAgentKill({ on: true, reason: "costo" })).toMatchObject({ scope: "GLOBAL", killed: true });
    expect(await rig.connector.runtime.isAgentKilled("g03")).toBe(true);
    expect((await (await rig.as(GUEST)).caller.policy.modes()).agentKill.global).toBe(true);
    expect(await caller.policy.setAgentKill({ on: false })).toMatchObject({ killed: false });
    expect(await rig.connector.runtime.isAgentKilled("g03")).toBe(false);
    const audits = await rig.connector.audit.listByAction("demo", "AGENT_KILL_SET");
    expect(audits.map((entry) => entry.refs.on)).toEqual(expect.arrayContaining(["true", "false"]));
    expect(audits.every((entry) => entry.actor === "OPERATOR:stf-supervisor-01")).toBe(true);
  });

  it("[FL-109] refuses an operator, a supervisor of another world, a stale sign-in and compliance", async () => {
    expect(await refusalOf(async () => (await rig.as(OPERATOR)).caller.policy.setAgentKill({ on: true }))).toBe("ROLE_NOT_ALLOWED");
    expect(await refusalOf(async () => (await rig.as(GUEST_SUPERVISOR)).caller.policy.setAgentKill({ on: true }))).toBe("WORLD_NOT_ALLOWED");
    expect(await refusalOf(async () => (await rig.as(SUPERVISOR, 20 * 60)).caller.policy.setAgentKill({ on: true }))).toBe("LOGIN_NOT_RECENT");
    expect(await refusalOf(async () => (await rig.as(COMPLIANCE)).caller.policy.setAgentKill({ on: true }))).toBe("READ_ONLY_ROLE");
    expect(await rig.connector.runtime.isAgentKilled("demo")).toBe(false);
  });
});
