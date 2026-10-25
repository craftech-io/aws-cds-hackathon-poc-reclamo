import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/bff/src/connector/memory/engine";
import { type InviteDeps, parseInviteArgs, runInvite, staffUserAttributes } from "./invite";

const POOL = "us-east-1_TESTPOOL1";
const RECIPIENT = "lucia.demo@craftech.io";

describe("staff invitation without a verified email, so staff never recover by email [FL-094] [FL-122]", () => {
  it("writes only the email and the world: never email_verified", () => {
    expect(staffUserAttributes(RECIPIENT, "demo")).toEqual([
      { Name: "email", Value: RECIPIENT },
      { Name: "custom:worldId", Value: "demo" },
    ]);
  });

  it("creates the staff user with those attributes and the invitation by email", async () => {
    const cognito = mockClient(CognitoIdentityProviderClient);
    cognito.on(DescribeUserPoolCommand).resolves({
      UserPool: { EmailConfiguration: { SourceArn: "arn:aws:ses:us-east-1:111122223333:identity/reclamo.demo.craftech.io", From: "Reclamo en regla <no-reply@reclamo.demo.craftech.io>" } },
    });
    cognito.on(AdminGetUserCommand).rejects(new UserNotFoundException({ message: "User does not exist.", $metadata: {} }));
    cognito.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: "sub", Value: "sub-operator-01" }, { Name: "email", Value: RECIPIENT }, { Name: "custom:worldId", Value: "demo" }], UserStatus: "FORCE_CHANGE_PASSWORD", Enabled: true },
    });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    const deps: InviteDeps = {
      cognito: new CognitoIdentityProviderClient({}),
      userPoolId: POOL,
      store: new MemoryStore(),
      demoRecipients: () => [RECIPIENT],
      guestWorld: { assertAvailable: () => undefined, create: () => Promise.reject(new Error("not a guest")) },
      saveCredential: () => "",
      password: () => "",
      now: () => new Date("2026-10-06T12:00:00Z"),
    };

    await runInvite(parseInviteArgs(["--world", "demo", "--role", "OPERATOR", "--email", RECIPIENT]), deps);

    const [create] = cognito.commandCalls(AdminCreateUserCommand).map((call) => call.args[0].input);
    expect(create?.UserAttributes).toEqual(staffUserAttributes(RECIPIENT, "demo"));
    expect(create?.UserAttributes?.some((attribute) => attribute.Name === "email_verified")).toBe(false);
    expect(create?.DesiredDeliveryMediums).toEqual(["EMAIL"]);
  });
});
