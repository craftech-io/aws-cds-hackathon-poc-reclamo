// Pre-token trigger with self-signup accounts (docs/architecture-guests.md §3): the invariant with
// the lead's world, tokens in any status of a `gs-*` world with `worldStatus`, the `READY` rule
// unchanged for everyone else, and audit entries without the email.
import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { STAFF_TEXT } from "../copy/es-AR";
import { createMemoryAudit, createMemoryDirectory, staffRow } from "../auth/testing";
import type { WorldStatus } from "../auth/staff";
import { createLogger } from "../lib/log";
import { ACCESS_DENIED, createPreTokenHandler } from "./pre-token";

const SUB = "3b7c1d2e-0000-4000-8000-00000000c001";
const WORLD = "gs-abcdefgh23";
const EMAIL = "ana@empresa-ficticia.ar";

function event(options: { username?: string; groups?: string[]; attribute?: string; source?: string } = {}): PreTokenGenerationV2TriggerEvent {
  const userAttributes: Record<string, string> = { sub: SUB, email: EMAIL };
  if (options.attribute) userAttributes["custom:worldId"] = options.attribute;
  return {
    version: "2",
    triggerSource: options.source ?? "TokenGeneration_Authentication",
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: options.username ?? EMAIL,
    callerContext: { awsSdkVersion: "x", clientId: "test-console-client" },
    request: { userAttributes, groupConfiguration: { groupsToOverride: options.groups ?? [] }, scopes: ["openid"] },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

function setup(status: WorldStatus, options: { role?: "GUEST" | "SUPERVISOR"; world?: string; leadWorld?: string | undefined } = {}) {
  const directory = createMemoryDirectory();
  const audit = createMemoryAudit();
  const world = options.world ?? WORLD;
  directory.putStaff(staffRow(world, `stf-${world}`, options.role ?? "GUEST", SUB));
  directory.setWorld(world, status, 1);
  const leadWorld = "leadWorld" in options ? options.leadWorld : WORLD;
  const handler = createPreTokenHandler(() => ({ directory, audit, leadWorldId: async () => leadWorld, log: createLogger({ sink: () => undefined }) }));
  return { handler, audit };
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "OTHER";
  }
}

describe("pre-token trigger and self-signup guests [FL-121]", () => {
  it.each(["REGISTERED", "CREATING", "READY", "EXPIRED"] as const)("issues tokens for a gs-* world %s, with the worldStatus claim", async (status) => {
    const { handler } = setup(status);
    const result = await handler(event());
    const claims = result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride;
    expect(claims).toEqual({ worldId: WORLD, staffId: `stf-${WORLD}`, role: "GUEST", worldStatus: status });
  });

  it("keeps the READY rule and no worldStatus for a gNN guest", async () => {
    const directory = createMemoryDirectory();
    directory.putStaff(staffRow("g03", "stf-guest-03", "GUEST", SUB));
    directory.setWorld("g03", "CREATING");
    const handler = createPreTokenHandler(() => ({ directory, audit: createMemoryAudit(), leadWorldId: async () => undefined, log: createLogger({ sink: () => undefined }) }));
    expect(await refusal(handler(event({ username: "guest-03", groups: ["GUEST"], attribute: "g03" })))).toBe(STAFF_TEXT.WORLD_NOT_READY);
    directory.setWorld("g03", "READY");
    const ok = await handler(event({ username: "guest-03", groups: ["GUEST"], attribute: "g03" }));
    expect(ok.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).not.toHaveProperty("worldStatus");
  });

  it.each([
    ["a gs-* row with SUPERVISOR", setup("READY", { role: "SUPERVISOR" }), event()],
    ["an email username whose row points to demo", setup("READY", { world: "demo" }), event()],
    ["an email username whose row points to a gNN", setup("READY", { world: "g04" }), event()],
    ["an email username whose row points to a qa-* world without -su", setup("READY", { world: "qa-r1-sc22" }), event()],
    ["an email username with a group", setup("READY"), event({ groups: ["GUEST"] })],
    ["an email username with custom:worldId", setup("READY"), event({ attribute: WORLD })],
    ["a gs-* row other than the lead's", setup("READY", { leadWorld: "gs-bbbbbbbbbb" }), event()],
    ["a self-signup without a lead", setup("READY", { leadWorld: undefined }), event()],
    ["a username without @ on a gs-* row", setup("READY"), event({ username: "guest-03", groups: ["GUEST"], attribute: WORLD })],
  ])("refuses %s and audits AUTH_WORLD_MISMATCH without the email", async (_label, { handler, audit }, input) => {
    expect(await refusal(handler(input))).toBe(ACCESS_DENIED);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.action).toBe("AUTH_WORLD_MISMATCH");
    expect(JSON.stringify(audit.entries)).not.toContain("@");
  });

  it("accepts the scenario runner's sign-up only in its own run", async () => {
    const qaUser = "success+qa-r7-su1@simulator.amazonses.com";
    const own = setup("REGISTERED", { world: "qa-r7-su1", leadWorld: "qa-r7-su1" });
    expect((await own.handler(event({ username: qaUser }))).response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).toMatchObject({
      worldId: "qa-r7-su1",
      worldStatus: "REGISTERED",
    });
    const other = setup("READY", { world: "qa-r8-su1", leadWorld: "qa-r8-su1" });
    expect(await refusal(other.handler(event({ username: qaUser })))).toBe(ACCESS_DENIED);
  });

  it("[FL-121] never takes qa-x@domain for a QA user: refused on a qa-* row and audited as a self-signup", async () => {
    const { handler, audit } = setup("READY", { world: "qa-r1-sc22" });
    expect(await refusal(handler(event({ username: "qa-x@empresa-ficticia.ar" })))).toBe(ACCESS_DENIED);
    expect(audit.entries[0]?.refs).toMatchObject({ usernameKind: "SIGNUP", staffId: "stf-qa-r1-sc22" });
    expect(JSON.stringify(audit.entries)).not.toContain("@");
  });

  it("[FL-121] still asks a username without @ for the attribute and the group", async () => {
    const directory = createMemoryDirectory();
    directory.putStaff(staffRow("g03", "stf-guest-03", "GUEST", SUB));
    directory.setWorld("g03", "READY");
    const audit = createMemoryAudit();
    const handler = createPreTokenHandler(() => ({ directory, audit, leadWorldId: async () => undefined, log: createLogger({ sink: () => undefined }) }));
    expect(await refusal(handler(event({ username: "guest-03", attribute: "g03" })))).toBe(ACCESS_DENIED);
    expect(await refusal(handler(event({ username: "guest-03", groups: ["GUEST"] })))).toBe(ACCESS_DENIED);
    expect(audit.entries.map((entry) => entry.outcome)).toEqual(["ROLE_NOT_IN_GROUPS", "ATTRIBUTE_MISMATCH"]);
    expect(audit.entries[0]?.refs).toMatchObject({ usernameKind: "STAFF", username: "guest-03" });
  });
});
