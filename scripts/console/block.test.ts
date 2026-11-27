import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryConnector } from "../../packages/bff/src/connector/memory/connector";
import type { Key } from "../../packages/bff/src/connector/store";
import { secondFactorRuntimeKeys } from "../../packages/bff/src/leads/keys";
import { describeBlock, parseBlockArgs, runBlock, secondFactorPassPrefix } from "./block";

const POOL = "us-east-1_TESTPOOL1";
const SUB = "5e6f7a8b-0000-4000-8000-00000000b10c";
const OTHER_SUB = "5e6f7a8b-0000-4000-8000-00000000b10d";
const cognito = mockClient(CognitoIdentityProviderClient);

async function rig() {
  const now = () => new Date("2026-11-27T18:00:00.000Z");
  const { connector, store } = createMemoryConnector({ now });
  const staff = (worldId: string, staffId: string, sub: string) => connector.worlds.putStaff({ worldId, staffId, role: "GUEST", displayName: "Invitado", cognitoSubKey: `SUB#${sub}`, active: true });
  await staff("gs-abcdefgh23", "stf-gs-abcdefgh23", SUB);
  await staff("g07", "stf-guest-07", OTHER_SUB);
  // Two passes of the blocked account's sessions and one of another account.
  const passes: Key[] = [secondFactorRuntimeKeys.session(SUB, "hash-a"), secondFactorRuntimeKeys.session(SUB, "hash-b"), secondFactorRuntimeKeys.session(OTHER_SUB, "hash-c")];
  for (const key of passes) await store.write({ kind: "put", table: "Runtime", item: { ...key, validUntilReal: "2026-11-28T06:00:00.000Z" } });
  // A filtered scan over the memory engine's items, like the stage's `Scan` of `Runtime`.
  const runtimeKeys = async (prefix: string) => {
    const kept: Key[] = [];
    for (const key of passes) if (key.pk.startsWith(prefix) && (await store.get("Runtime", key))) kept.push(key);
    return kept;
  };
  const deps = { cognito: new CognitoIdentityProviderClient({}), userPoolId: POOL, store, runtimeKeys, now };
  return { connector, store, deps, passes };
}

beforeEach(() => {
  cognito.reset();
  cognito.on(AdminGetUserCommand, { Username: "ana@empresa-ficticia.ar" }).resolves({ Username: "ana@empresa-ficticia.ar", UserAttributes: [{ Name: "sub", Value: SUB }] });
  cognito.on(AdminGetUserCommand, { Username: "nadie" }).rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
  cognito.on(AdminDisableUserCommand).resolves({});
  cognito.on(AdminEnableUserCommand).resolves({});
  cognito.on(AdminUserGlobalSignOutCommand).resolves({});
});

describe("console:block [FL-132]", () => {
  it("[FL-132] blocks: marks the account's staff rows, disables it, signs it out everywhere and deletes its SMS-code passes", async () => {
    const r = await rig();
    const report = await runBlock({ user: "ana@empresa-ficticia.ar", off: false }, r.deps);
    expect(await r.connector.worlds.getStaff("gs-abcdefgh23", "stf-gs-abcdefgh23")).toMatchObject({ blocked: true, blockedAtReal: "2026-11-27T18:00:00.000Z", active: true });
    expect(await r.connector.worlds.getStaff("g07", "stf-guest-07")).not.toHaveProperty("blocked");
    const pool = { UserPoolId: POOL, Username: "ana@empresa-ficticia.ar" };
    expect(cognito.commandCalls(AdminDisableUserCommand).map((call) => call.args[0].input)).toEqual([pool]);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand).map((call) => call.args[0].input)).toEqual([pool]);
    expect(await r.store.get("Runtime", r.passes[0] as Key)).toBeUndefined();
    expect(await r.store.get("Runtime", r.passes[1] as Key)).toBeUndefined();
    expect(await r.store.get("Runtime", r.passes[2] as Key)).toBeDefined();
    expect(report).toEqual({ mode: "block", subPrefix: SUB.slice(0, 8), staff: ["gs-abcdefgh23/stf-gs-abcdefgh23"], passesDeleted: 2 });
    expect(describeBlock(report)).not.toContain("@");
  });

  it("[FL-132] unblocks: enables the account and clears the mark, leaving the rest of the row as it was", async () => {
    const r = await rig();
    await runBlock({ user: "ana@empresa-ficticia.ar", off: false }, r.deps);
    const report = await runBlock({ user: "ana@empresa-ficticia.ar", off: true }, r.deps);
    expect(cognito.commandCalls(AdminEnableUserCommand)).toHaveLength(1);
    const row = await r.connector.worlds.getStaff("gs-abcdefgh23", "stf-gs-abcdefgh23");
    expect(row).not.toHaveProperty("blocked");
    expect(row).not.toHaveProperty("blockedAtReal");
    expect(row).toMatchObject({ active: true });
    expect(describeBlock(report)).toContain("unblocked");
  });

  it("[FL-132] finds a staff account by its email attribute when the username is not an email, and refuses an unknown one", async () => {
    const r = await rig();
    cognito.on(AdminGetUserCommand, { Username: "lucia@craftech.io" }).rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    cognito.on(ListUsersCommand, { Filter: 'email = "lucia@craftech.io"' }).resolves({ Users: [{ Username: "guest-07", Attributes: [{ Name: "sub", Value: OTHER_SUB }] }] });
    expect((await runBlock({ user: "lucia@craftech.io", off: false }, r.deps)).staff).toEqual(["g07/stf-guest-07"]);
    await expect(runBlock({ user: "nadie", off: false }, r.deps)).rejects.toThrow(RangeError);
  });

  it("parses --user and --off, normalizes an email and refuses anything else", () => {
    expect(parseBlockArgs(["--user", " Ana@Empresa-Ficticia.AR "])).toEqual({ user: "ana@empresa-ficticia.ar", off: false });
    expect(parseBlockArgs(["--user", "guest-07", "--off"])).toEqual({ user: "guest-07", off: true });
    expect(() => parseBlockArgs([])).toThrow(RangeError);
    expect(() => parseBlockArgs(["--user", 'a"b@x.ar'])).toThrow(RangeError);
    expect(() => parseBlockArgs(["--user", "guest-07", "--force"])).toThrow(RangeError);
    expect(secondFactorPassPrefix(SUB)).toBe(`SECONDFACTOR#${SUB}#`);
    expect(secondFactorRuntimeKeys.session(SUB, "h").pk.startsWith(secondFactorPassPrefix(SUB))).toBe(true);
  });
});
