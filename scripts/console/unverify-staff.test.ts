import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { describeUnverify, exitCodeOf, parseUnverifyArgs, runUnverify } from "./unverify-staff";

const POOL = "us-east-1_TESTPOOL1";
const cognito = mockClient(CognitoIdentityProviderClient);
const user = (username: string, verified?: "true" | "false") => ({ Username: username, Attributes: verified === undefined ? [] : [{ Name: "email_verified", Value: verified }] });

beforeEach(() => {
  cognito.reset();
  cognito
    .on(ListUsersCommand)
    .resolvesOnce({ Users: [user("operator-01", "true"), user("guest-03"), user("success+qa-r1@simulator.amazonses.com", "true")], PaginationToken: "next" })
    .resolvesOnce({ Users: [user("supervisor-01", "false"), user("qa-r1-sc01-operator", "true")] });
  cognito.on(AdminUpdateUserAttributesCommand).resolves({});
});

describe("console:unverify-staff [FL-094]", () => {
  it("--check lists every account without @ with a verified email, reads only email_verified and fails", async () => {
    const outcome = await runUnverify(true, { cognito: new CognitoIdentityProviderClient({}), userPoolId: POOL });
    expect(outcome.verified).toEqual(["operator-01", "qa-r1-sc01-operator"]);
    expect(exitCodeOf(outcome)).toBe(1);
    expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
    const lists = cognito.commandCalls(ListUsersCommand).map((call) => call.args[0].input);
    expect(lists.map((input) => input.AttributesToGet)).toEqual([["email_verified"], ["email_verified"]]);
    expect(lists[1]?.PaginationToken).toBe("next");
    expect(describeUnverify(outcome)).not.toContain("amazonses");
  });

  it("sets email_verified = false on exactly those accounts and never on a self-signup account", async () => {
    const outcome = await runUnverify(false, { cognito: new CognitoIdentityProviderClient({}), userPoolId: POOL });
    const updates = cognito.commandCalls(AdminUpdateUserAttributesCommand).map((call) => call.args[0].input);
    expect(updates).toEqual([
      { UserPoolId: POOL, Username: "operator-01", UserAttributes: [{ Name: "email_verified", Value: "false" }] },
      { UserPoolId: POOL, Username: "qa-r1-sc01-operator", UserAttributes: [{ Name: "email_verified", Value: "false" }] },
    ]);
    expect(outcome.updated).toBe(2);
    expect(exitCodeOf(outcome)).toBe(0);
  });

  it("is idempotent: a second check after the fix finds nothing and passes", async () => {
    cognito.reset();
    cognito.on(ListUsersCommand).resolves({ Users: [user("operator-01", "false"), user("guest-03")] });
    const outcome = await runUnverify(true, { cognito: new CognitoIdentityProviderClient({}), userPoolId: POOL });
    expect(outcome.verified).toEqual([]);
    expect(exitCodeOf(outcome)).toBe(0);
  });

  it("accepts only --check", () => {
    expect(parseUnverifyArgs([])).toEqual({ check: false });
    expect(parseUnverifyArgs(["--check"])).toEqual({ check: true });
    expect(() => parseUnverifyArgs(["--apply"])).toThrow(RangeError);
  });
});
