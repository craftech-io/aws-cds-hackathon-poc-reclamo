// The self-signup side of the identity invariant in the BFF (docs/architecture-guests.md §3):
// `principalFromClaims` with the claims a token of each kind carries.
import { describe, expect, it } from "vitest";
import { AUTH_REASON, AuthError } from "./errors";
import { signupIdentityProblem } from "./guest-identity";
import { IdTokenClaims } from "./jwt";
import { isQaUsername, principalFromClaims } from "./principal";

const SUB = "3b7c1d2e-0000-4000-8000-00000000c001";
const GUEST_WORLD = "gs-abcdefgh23";
const worldOf = (sub: string) => (sub === SUB ? GUEST_WORLD : "gs-zzzzzzzzzz");

function claims(overrides: Record<string, unknown>): IdTokenClaims {
  return IdTokenClaims.parse({
    sub: SUB,
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1",
    aud: "test-console-client",
    token_use: "id",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    auth_time: 1_900_000_000,
    origin_jti: "0d1c2b3a-0000-4000-8000-00000000a001",
    "cognito:username": "ana@empresa-ficticia.ar",
    worldId: GUEST_WORLD,
    staffId: `stf-${GUEST_WORLD}`,
    role: "GUEST",
    ...overrides,
  });
}

function refusal(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AuthError ? error.reason : "OTHER";
  }
}

describe("principalFromClaims: the guest identity invariant [FL-121]", () => {
  it("accepts a self-signup guest: email username, its own gs-* world, GUEST, no groups", () => {
    const principal = principalFromClaims(claims({}), "console", worldOf);
    expect(principal).toMatchObject({ worldId: GUEST_WORLD, role: "GUEST", isGuest: true, sessionId: "0d1c2b3a-0000-4000-8000-00000000a001" });
  });

  it.each([
    ["a gs-* row with SUPERVISOR", { role: "SUPERVISOR" }],
    ["an email username on demo", { worldId: "demo", staffId: "stf-operator-01" }],
    ["an email username on a gNN world", { worldId: "g03", staffId: "stf-guest-03" }],
    ["an email username on a qa-* world without -su", { worldId: "qa-r1-sc22", staffId: "stf-qa-guest" }],
    ["an email username with a group", { "cognito:groups": ["GUEST"] }],
    ["a gs-* world other than the lead's", { worldId: "gs-bbbbbbbbbb", staffId: "stf-gs-bbbbbbbbbb" }],
    ["a username without @ on a gs-* world", { "cognito:username": "guest-03", "cognito:groups": ["GUEST"] }],
  ])("refuses %s with PRINCIPAL_INCOMPLETE", (_label, overrides) => {
    expect(refusal(() => principalFromClaims(claims(overrides), "console", worldOf))).toBe(AUTH_REASON.PRINCIPAL_INCOMPLETE);
  });

  it("fails closed when the BFF cannot derive the guest's world", () => {
    expect(refusal(() => principalFromClaims(claims({}), "console"))).toBe(AUTH_REASON.PRINCIPAL_INCOMPLETE);
  });

  it("keeps the two signals of today for a username without @", () => {
    const staff = { "cognito:username": "guest-03", worldId: "g03", staffId: "stf-guest-03", role: "GUEST" };
    expect(principalFromClaims(claims({ ...staff, "cognito:groups": ["GUEST"] }), "console").worldId).toBe("g03");
    expect(refusal(() => principalFromClaims(claims(staff), "console"))).toBe(AUTH_REASON.PRINCIPAL_INCOMPLETE);
  });

  it("accepts the scenario runner's sign-up only in its own qa-<runId>-su<n> world", () => {
    const qa = { "cognito:username": "success+qa-r7-su2@simulator.amazonses.com", worldId: "qa-r7-su2", staffId: "stf-qa-r7-su2" };
    expect(principalFromClaims(claims(qa), "console").worldId).toBe("qa-r7-su2");
    expect(refusal(() => principalFromClaims(claims({ ...qa, worldId: "qa-r8-su2", staffId: "stf-qa-r8-su2" }), "console"))).toBe(AUTH_REASON.PRINCIPAL_INCOMPLETE);
  });
});

describe("qa usernames never have @ [FL-121]", () => {
  it("does not treat qa-x@domain as a QA user", () => {
    expect(isQaUsername("qa-x@empresa-ficticia.ar")).toBe(false);
    expect(isQaUsername("qa-r1-sc01-operator")).toBe(true);
  });

  it("names the broken rule", () => {
    const base = { username: "ana@empresa-ficticia.ar", worldId: GUEST_WORLD, role: "GUEST", groups: [], leadWorldId: GUEST_WORLD };
    expect(signupIdentityProblem(base)).toBeUndefined();
    expect(signupIdentityProblem({ ...base, attributeWorldId: GUEST_WORLD })).toBe("SIGNUP_USER_WITH_ATTRIBUTE");
    expect(signupIdentityProblem({ ...base, leadWorldId: undefined })).toBe("LEAD_WORLD_MISMATCH");
    expect(signupIdentityProblem({ ...base, username: "operator-01" })).toBe("STAFF_USER_IN_SIGNUP_WORLD");
  });
});
