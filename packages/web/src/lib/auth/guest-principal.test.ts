import { describe, expect, it } from "vitest";
import { principalFromIdToken } from "../auth-claims";
import { isSelfSignupGuest, isSignupWorld } from "./guest-principal";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "k" })}.${encode(payload)}.signature`;
}

const EMAIL = "success+qa-run7-su1@simulator.amazonses.com";
const base = { sub: "sub-1", iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", aud: "client", exp: 1_800_000_000, iat: 1_799_999_100, token_use: "id" };

describe("a self-signup guest in the console [FL-121]", () => {
  it("tells self-signup worlds from every other", () => {
    expect(isSignupWorld("gs-abcdefgh23")).toBe(true);
    expect(isSignupWorld("qa-run7-su1")).toBe(true);
    expect(isSignupWorld("g03")).toBe(false);
    expect(isSignupWorld("demo")).toBe(false);
    expect(isSignupWorld("qa-run7-sc01")).toBe(false);
    expect(isSignupWorld(undefined)).toBe(false);
  });

  it("gets GUEST without a group only under the identity invariant", () => {
    const guest = { username: "visitante@dominio-ficticio.ar", worldId: "gs-abcdefgh23", role: "GUEST", groups: [] };
    expect(isSelfSignupGuest(guest)).toBe(true);
    expect(isSelfSignupGuest({ ...guest, groups: ["GUEST"] })).toBe(false);
    expect(isSelfSignupGuest({ ...guest, role: "SUPERVISOR" })).toBe(false);
    expect(isSelfSignupGuest({ ...guest, worldId: "demo" })).toBe(false);
    expect(isSelfSignupGuest({ ...guest, worldId: "g03" })).toBe(false);
    expect(isSelfSignupGuest({ ...guest, username: "guest-03" })).toBe(false);
    expect(isSelfSignupGuest({ username: EMAIL, worldId: "qa-run7-su1", role: "GUEST", groups: [] })).toBe(true);
    expect(isSelfSignupGuest({ username: EMAIL, worldId: "qa-other-su1", role: "GUEST", groups: [] })).toBe(false);
  });

  it("decodes the principal of a self-signup token: role GUEST, no group, flagged as self-signup", () => {
    const principal = principalFromIdToken(jwt({ ...base, "cognito:username": EMAIL, worldId: "qa-run7-su1", staffId: "stf-qa-run7-su1", role: "GUEST", worldStatus: "REGISTERED" }));
    expect(principal).toMatchObject({ role: "GUEST", worldId: "qa-run7-su1", selfSignup: true });
  });

  it("keeps the group rule for everyone else", () => {
    const staff = principalFromIdToken(jwt({ ...base, "cognito:username": "guest-03", worldId: "g03", staffId: "stf-guest-03", role: "GUEST" }));
    expect(staff.role).toBeUndefined();
    expect(staff.selfSignup).toBeUndefined();
  });
});
