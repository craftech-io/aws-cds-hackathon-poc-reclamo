import { describe, expect, it } from "vitest";
import { parseIdTokenClaims, principalFromClaims, principalFromIdToken } from "./auth-claims";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "k" })}.${encode(payload)}.signature`;
}

const base = {
  sub: "sub-1",
  iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x",
  aud: "client",
  exp: 1_800_000_000,
  iat: 1_799_999_100,
  auth_time: 1_799_999_100,
  token_use: "id",
  "cognito:username": "guest-03",
};

describe("principal from the id token [FL-094]", () => {
  it("reads world, staff id and role stamped by the pre-token trigger", () => {
    const principal = principalFromIdToken(jwt({ ...base, worldId: "g03", staffId: "stf-guest-03", role: "GUEST", "cognito:groups": ["GUEST"] }));
    expect(principal).toEqual({ sub: "sub-1", username: "guest-03", worldId: "g03", staffId: "stf-guest-03", role: "GUEST", expiresAt: 1_800_000_000_000, authTime: 1_799_999_100 });
  });

  it("ignores a stamped role that is not a group of the user, or not a console role", () => {
    expect(principalFromClaims(parseIdTokenClaims(jwt({ ...base, role: "SUPERVISOR", "cognito:groups": ["OPERATOR"] }))).role).toBeUndefined();
    expect(principalFromIdToken(jwt({ ...base, role: "ROOT", "cognito:groups": ["ROOT"] })).role).toBeUndefined();
  });

  it("leaves the world undefined for an incomplete account", () => {
    expect(principalFromIdToken(jwt(base)).worldId).toBeUndefined();
  });

  it("rejects access tokens and malformed tokens", () => {
    expect(() => principalFromIdToken(jwt({ ...base, token_use: "access" }))).toThrow();
    expect(() => principalFromIdToken("not-a-jwt")).toThrow();
  });
});
