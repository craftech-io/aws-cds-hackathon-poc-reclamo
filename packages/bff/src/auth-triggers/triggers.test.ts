import { readFileSync } from "node:fs";
import { type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { PreSignUpTriggerEvent, PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { StaffRole } from "@reclamo/shared";
import { connectorAuditSink, connectorWorldDirectory } from "../auth/directory";
import type { WorldStatus } from "../auth/staff";
import { createMemoryAudit, createMemoryDirectory, staffRow } from "../auth/testing";
import { createDynamoConnector } from "../connector/dynamo/connector";
import { STAFF_TEXT } from "../copy/es-AR";
import { createLogger } from "../lib/log";
import { ACCESS_DENIED, ADMIN_SCOPE, WORLD_ATTRIBUTE, createPreTokenHandler } from "./pre-token";
import { ADMIN_CREATE_USER, SIGN_UP_DISABLED, handler as preSignUp } from "./pre-sign-up";

const GUEST_SUB = "3b0f5e2a-0000-4000-8000-0000000000j3";
const silent = () => createLogger({ sink: () => undefined });

type Source = PreTokenGenerationV2TriggerEvent["triggerSource"];

function tokenEvent(options: { source?: Source; username?: string; sub?: string; worldAttribute?: string | undefined; groups?: string[] } = {}): PreTokenGenerationV2TriggerEvent {
  const userAttributes: Record<string, string> = { sub: options.sub ?? GUEST_SUB, "cognito:user_status": "CONFIRMED" };
  const world = "worldAttribute" in options ? options.worldAttribute : "g03";
  if (world !== undefined) userAttributes[WORLD_ATTRIBUTE] = world;
  return {
    version: "2",
    triggerSource: options.source ?? "TokenGeneration_Authentication",
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: options.username ?? "guest-03",
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "test-console-client" },
    request: { userAttributes, groupConfiguration: { groupsToOverride: options.groups ?? ["GUEST"] }, scopes: [ADMIN_SCOPE, "openid"] },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

function setup(status: WorldStatus | null = "READY") {
  const directory = createMemoryDirectory();
  const audit = createMemoryAudit();
  directory.putStaff(staffRow("g03", "stf-guest-03", "GUEST", GUEST_SUB));
  if (status) directory.setWorld("g03", status, 4);
  directory.setWorld("demo", "READY", 2);
  directory.setWorld("qa-r1-sc22j", "READY", 1);
  const handler = createPreTokenHandler(() => ({ directory, audit, leadWorldId: async () => undefined, log: silent() }));
  return { directory, audit, handler };
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected the trigger to refuse");
}

describe("pre-token trigger: world, role and staff id only from the staff row [FL-094]", () => {
  it("stamps world, staff id and role from the STAFF# row and suppresses the attribute", async () => {
    const { handler, audit } = setup();
    const result = await handler(tokenEvent());
    const details = result.response.claimsAndScopeOverrideDetails;
    expect(details.idTokenGeneration?.claimsToAddOrOverride).toEqual({ worldId: "g03", staffId: "stf-guest-03", role: "GUEST" });
    expect(details.idTokenGeneration?.claimsToSuppress).toEqual([WORLD_ATTRIBUTE]);
    expect(audit.entries).toEqual([]);
  });

  it.each<StaffRole>(["OPERATOR", "SUPERVISOR", "COMPLIANCE", "GUEST"])(
    "suppresses the account-admin scope for %s, so UpdateUserAttributes, ChangePassword and DeleteUser answer NotAuthorized",
    async (role) => {
      const { handler, directory } = setup();
      const staffId = `stf-${role.toLowerCase()}-03`;
      directory.putStaff(staffRow("demo", staffId, role, "sub-demo-staff"));
      const result = await handler(tokenEvent({ sub: "sub-demo-staff", username: `${role.toLowerCase()}-03`, worldAttribute: "demo", groups: [role] }));
      expect(result.response.claimsAndScopeOverrideDetails.accessTokenGeneration?.scopesToSuppress).toEqual([ADMIN_SCOPE]);
      expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).toMatchObject({ worldId: "demo", role });
    },
  );

  it("never lets a forged attribute choose the world: a mismatch fails the sign-in and is audited", async () => {
    const { handler, audit } = setup();
    expect(await refusalOf(handler(tokenEvent({ worldAttribute: "demo" })))).toBe(ACCESS_DENIED);
    expect(audit.entries).toEqual([
      expect.objectContaining({ worldId: "g03", epoch: 4, action: "AUTH_WORLD_MISMATCH", outcome: "ATTRIBUTE_MISMATCH", actor: "SYSTEM", refs: expect.objectContaining({ staffId: "stf-guest-03" }) }),
    ]);
    expect(await refusalOf(handler(tokenEvent({ worldAttribute: undefined })))).toBe(ACCESS_DENIED);
  });

  it("fails without a staff row for the sub, or with two", async () => {
    const { handler, audit, directory } = setup();
    expect(await refusalOf(handler(tokenEvent({ sub: "nobody" })))).toBe(ACCESS_DENIED);
    expect(audit.entries.at(-1)).toMatchObject({ worldId: "g03", action: "AUTH_WORLD_MISMATCH", outcome: "NO_STAFF_ROW" });
    directory.putStaff(staffRow("g04", "stf-guest-04", "GUEST", GUEST_SUB));
    expect(await refusalOf(handler(tokenEvent()))).toBe(ACCESS_DENIED);
    expect(audit.entries.at(-1)).toMatchObject({ action: "AUTH_WORLD_MISMATCH", outcome: "AMBIGUOUS_STAFF_ROW" });
  });

  it("fails a qa-* user whose staff row is outside a qa-* world, and accepts one inside", async () => {
    const { handler, audit, directory } = setup();
    directory.putStaff(staffRow("demo", "stf-qa-operator", "OPERATOR", "sub-qa-1"));
    const outside = tokenEvent({ sub: "sub-qa-1", username: "qa-r1-sc22-operator", worldAttribute: "demo", groups: ["OPERATOR"] });
    expect(await refusalOf(handler(outside))).toBe(ACCESS_DENIED);
    expect(audit.entries.at(-1)).toMatchObject({ worldId: "demo", outcome: "QA_USER_OUTSIDE_QA_WORLD" });
    directory.putStaff(staffRow("qa-r1-sc22j", "stf-qa-guest", "GUEST", "sub-qa-2"));
    const inside = await handler(tokenEvent({ sub: "sub-qa-2", username: "qa-r1-sc22j-guest", worldAttribute: "qa-r1-sc22j" }));
    expect(inside.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).toMatchObject({ worldId: "qa-r1-sc22j", role: "GUEST" });
  });

  it("fails when the row's role is not a group of the user, or the row is inactive", async () => {
    const { handler, directory } = setup();
    expect(await refusalOf(handler(tokenEvent({ groups: ["OPERATOR"] })))).toBe(ACCESS_DENIED);
    directory.putStaff(staffRow("g03", "stf-guest-03", "GUEST", GUEST_SUB, { active: false }));
    expect(await refusalOf(handler(tokenEvent()))).toBe(ACCESS_DENIED);
  });

  it.each<[string, WorldStatus | null]>([
    ["REGISTERED", "REGISTERED"],
    ["CREATING", "CREATING"],
    ["RESETTING", "RESETTING"],
    ["without META", null],
  ])(
    "refuses a sign-in to a world %s with the fixed text, audits WORLD_NOT_READY and writes nothing else",
    async (_label, status) => {
      const { handler, audit, directory } = setup(status);
      expect(await refusalOf(handler(tokenEvent()))).toBe(STAFF_TEXT.WORLD_NOT_READY);
      expect(audit.entries).toEqual([expect.objectContaining({ worldId: "g03", action: "WORLD_NOT_READY", outcome: status ?? "MISSING" })]);
      expect((await directory.meta("g03"))?.status).toBe(status ?? undefined);
    },
  );

  it("renews a refresh while the world is RESETTING, never while it is being created", async () => {
    const resetting = setup("RESETTING");
    const renewed = await resetting.handler(tokenEvent({ source: "TokenGeneration_RefreshTokens" }));
    expect(renewed.response.claimsAndScopeOverrideDetails.accessTokenGeneration?.scopesToSuppress).toEqual([ADMIN_SCOPE]);
    const creating = setup("CREATING");
    expect(await refusalOf(creating.handler(tokenEvent({ source: "TokenGeneration_RefreshTokens" })))).toBe(STAFF_TEXT.WORLD_NOT_READY);
  });

  it("applies the READY rule to every sign-in source", async () => {
    for (const source of ["TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice", "TokenGeneration_HostedAuth"] as const) {
      expect(await refusalOf(setup("CREATING").handler(tokenEvent({ source })))).toBe(STAFF_TEXT.WORLD_NOT_READY);
    }
  });

  it("fails closed on an outage, a slow read, an audit failure or an unexpected event", async () => {
    const outage = setup();
    outage.directory.failWith(new Error("ProvisionedThroughputExceededException"));
    expect(await refusalOf(outage.handler(tokenEvent()))).toBe(ACCESS_DENIED);
    expect(outage.audit.entries).toEqual([]);

    const directory = createMemoryDirectory();
    const slow = createPreTokenHandler(
      () => ({ directory: { ...directory, staffBySub: () => new Promise(() => undefined) }, audit: createMemoryAudit(), leadWorldId: async () => undefined, log: silent() }),
      50,
    );
    expect(await refusalOf(slow(tokenEvent()))).toBe(ACCESS_DENIED);

    const auditDown = setup("CREATING");
    auditDown.audit.failWith(new Error("AccessDenied"));
    expect(await refusalOf(auditDown.handler(tokenEvent()))).toBe(STAFF_TEXT.WORLD_NOT_READY);

    const { handler } = setup();
    expect(await refusalOf(handler({ ...tokenEvent(), triggerSource: "TokenGeneration_Unknown" } as unknown as PreTokenGenerationV2TriggerEvent))).toBe(ACCESS_DENIED);
  });
});

describe("pre-token trigger over DynamoDB: reads Worlds, appends AuditLog, never writes a world [FL-094]", () => {
  function recordingClient(meta: Record<string, unknown> | undefined) {
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
    const row = staffRow("g03", "stf-guest-03", "GUEST", GUEST_SUB);
    return {
      sent,
      async send(command: GetCommand | QueryCommand | PutCommand): Promise<unknown> {
        const input = command.input as Record<string, unknown>;
        sent.push({ command: command.constructor.name, input });
        if (command instanceof QueryCommand) return { Items: [{ pk: "W#g03#WORLD", sk: "STAFF#stf-guest-03", cognitoSubKey: `SUB#${GUEST_SUB}` }] };
        if (command instanceof GetCommand) {
          const key = input.Key as { sk: string };
          return { Item: key.sk === "META" ? meta : { pk: "W#g03#WORLD", sk: key.sk, ...row, displayName: "Invitado 03", version: 1 } };
        }
        return {};
      },
    };
  }

  function dynamoHandler(client: ReturnType<typeof recordingClient>) {
    const connector = createDynamoConnector({
      client: client as unknown as DynamoDBDocumentClient,
      tableName: (table) => `${table}-table`,
      now: () => new Date("2026-10-07T13:10:00Z"),
    });
    return createPreTokenHandler(() => ({
      directory: connectorWorldDirectory(connector.worlds),
      audit: connectorAuditSink(connector.audit, () => new Date("2026-10-07T13:10:00Z")),
      leadWorldId: async () => undefined,
      log: silent(),
    }));
  }

  it("queries BySub, re-reads the row and META by key, and writes nothing on success", async () => {
    const client = recordingClient({ pk: "W#g03#WORLD", sk: "META", worldId: "g03", kind: "GUEST", template: "guest", status: "READY", epoch: 4, version: 3 });
    await dynamoHandler(client)(tokenEvent());
    expect(client.sent.map((call) => call.command).sort()).toEqual(["GetCommand", "GetCommand", "QueryCommand"]);
    expect(client.sent.find((call) => call.command === "QueryCommand")?.input).toMatchObject({ TableName: "Worlds-table", IndexName: "BySub" });
    expect(Object.values((client.sent.find((call) => call.command === "QueryCommand")?.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>)).toContain(`SUB#${GUEST_SUB}`);
    for (const call of client.sent.filter((c) => c.command === "GetCommand")) expect(call.input).toMatchObject({ TableName: "Worlds-table", ConsistentRead: true });
  });

  it("appends one AuditLog entry with a condition, in the world's epoch partition, when the world is not ready", async () => {
    const client = recordingClient({ pk: "W#g03#WORLD", sk: "META", worldId: "g03", kind: "GUEST", template: "guest", status: "CREATING", epoch: 4, version: 3 });
    expect(await refusalOf(dynamoHandler(client)(tokenEvent()))).toBe(STAFF_TEXT.WORLD_NOT_READY);
    const writes = client.sent.filter((call) => call.command === "PutCommand");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.input).toMatchObject({
      TableName: "AuditLog-table",
      ConditionExpression: expect.stringContaining("attribute_not_exists"),
      Item: { pk: "W#g03#AUD#e4#2026-10", worldId: "g03", action: "WORLD_NOT_READY", outcome: "CREATING", actor: "SYSTEM", actionKey: "W#g03#WORLD_NOT_READY" },
    });
    expect(client.sent.every((call) => call.command !== "PutCommand" || call.input.TableName === "AuditLog-table")).toBe(true);
  });

  it("never imports the world factory nor any writer of Worlds", () => {
    const source = readFileSync(new URL("./pre-token.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\.\/worlds\//);
    expect(source).not.toMatch(/UpdateCommand|DeleteCommand|TransactWrite|BatchWrite/);
  });
});

describe("pre-sign-up trigger: no self sign-up [FL-094]", () => {
  function signUpEvent(triggerSource: PreSignUpTriggerEvent["triggerSource"]): PreSignUpTriggerEvent {
    return {
      version: "1",
      triggerSource,
      region: "us-east-1",
      userPoolId: "us-east-1_TESTPOOL1",
      userName: "someone",
      callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "test-console-client" },
      request: { userAttributes: { email: "someone@example.com" } },
      response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
    };
  }

  it("refuses a self sign-up and an external provider", async () => {
    expect(await refusalOf(preSignUp(signUpEvent("PreSignUp_SignUp")))).toBe(SIGN_UP_DISABLED);
    expect(await refusalOf(preSignUp(signUpEvent("PreSignUp_ExternalProvider")))).toBe(SIGN_UP_DISABLED);
  });

  it("lets AdminCreateUser through without confirming or verifying anything", async () => {
    const result = await preSignUp(signUpEvent(ADMIN_CREATE_USER));
    expect(result.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
  });
});
