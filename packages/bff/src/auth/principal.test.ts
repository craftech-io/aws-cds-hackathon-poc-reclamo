import { describe, expect, it } from "vitest";
import { AUTH_REASON } from "./errors";
import { IdTokenClaims } from "./jwt";
import { inProcessPrincipal, inProcessWorldAllowed, isSignInFresh, principalFromClaims, serverClientAllowed } from "./principal";
import { sessionPresence } from "./session-presence";
import { withStaffCache } from "./staff";
import { createMemoryDirectory, staffRow } from "./testing";

const NOW = Math.floor(Date.parse("2026-10-07T13:10:00Z") / 1000);

function claims(overrides: Record<string, unknown> = {}): IdTokenClaims {
  return IdTokenClaims.parse({
    sub: "sub-1",
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1",
    aud: "client",
    token_use: "id",
    exp: NOW + 900,
    iat: NOW,
    auth_time: NOW,
    origin_jti: "jti-origin-1",
    "cognito:username": "operator-01",
    "cognito:groups": ["OPERATOR"],
    worldId: "demo",
    staffId: "stf-operator-01",
    role: "OPERATOR",
    ...overrides,
  });
}

describe("principal [FL-094]", () => {
  it("takes world, staff id and role from the claims the pre-token trigger stamped", () => {
    expect(principalFromClaims(claims(), "console")).toMatchObject({ worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", isGuest: false, authTime: NOW, audience: "console" });
    const guest = principalFromClaims(claims({ "cognito:username": "guest-03", "cognito:groups": ["GUEST"], worldId: "g03", staffId: "stf-guest-03", role: "GUEST" }), "console");
    expect(guest).toMatchObject({ worldId: "g03", isGuest: true });
  });

  it("refuses a token without a valid world, staff id or role, or a role that is not a group", () => {
    for (const overrides of [{ worldId: undefined }, { worldId: "Demo" }, { worldId: "world-x" }, { staffId: "operator" }, { role: "ADMIN" }, { "cognito:groups": ["COMPLIANCE"] }]) {
      expect(() => principalFromClaims(claims(overrides), "console")).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    }
  });

  it("identifies the session by origin_jti, and qa-* users by their sub", () => {
    expect(principalFromClaims(claims(), "console").sessionId).toBe("jti-origin-1");
    expect(principalFromClaims(claims({ origin_jti: undefined }), "console").sessionId).toBe("sub-1");
    const qa = principalFromClaims(claims({ "cognito:username": "qa-r1-sc21-guest", worldId: "qa-r1-sc21", staffId: "stf-qa-guest", role: "GUEST", "cognito:groups": ["GUEST"] }), "server");
    expect(qa.sessionId).toBe("sub-1");
  });

  it("accepts the ServerClient audience only for a qa-* user whose staff row is in a qa-* world", () => {
    const qa = principalFromClaims(claims({ "cognito:username": "qa-r1-sc18-operator", worldId: "qa-r1-sc18", staffId: "stf-qa-operator" }), "server");
    const row = staffRow("qa-r1-sc18", "stf-qa-operator", "OPERATOR", "sub-1");
    expect(serverClientAllowed(qa, row)).toBe(true);
    expect(serverClientAllowed(qa, undefined)).toBe(false);
    expect(serverClientAllowed(qa, { ...row, cognitoSubKey: "SUB#other" })).toBe(false);
    expect(serverClientAllowed(qa, { ...row, active: false })).toBe(false);
    const notQaUser = principalFromClaims(claims({ worldId: "qa-r1-sc18" }), "server");
    expect(serverClientAllowed(notQaUser, row)).toBe(false);
    const qaUserInDemo = principalFromClaims(claims({ "cognito:username": "qa-r1-sc18-operator" }), "server");
    expect(serverClientAllowed(qaUserInDemo, staffRow("demo", "stf-operator-01", "OPERATOR", "sub-1"))).toBe(false);
    const qaUserInQamin = principalFromClaims(claims({ "cognito:username": "qa-r1-sc18-operator", worldId: "qamin" }), "server");
    expect(serverClientAllowed(qaUserInQamin, staffRow("qamin", "stf-operator-01", "OPERATOR", "sub-1"))).toBe(false);
    expect(serverClientAllowed(principalFromClaims(claims(), "console"), undefined)).toBe(true);
  });

  it("keeps the recent-login window at 15 minutes with 60 s of skew", () => {
    const at = (seconds: number) => new Date((NOW + seconds) * 1000);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60 + 1))).toBe(false);
    expect(isSignInFresh({ authTime: NOW }, at(-60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(-61))).toBe(false);
  });
});

describe("in-process principal of the QaDriver [FL-099]", () => {
  it("is built on the server for QA worlds only, and GUEST only in qa-* worlds", () => {
    expect(inProcessPrincipal({ worldId: "qa-r1-sc18", role: "OPERATOR", authTime: NOW })).toMatchObject({ sub: "qa", staffId: "stf-qa-operator", audience: "in-process" });
    expect(inProcessPrincipal({ worldId: "qa-r1-sc21", role: "GUEST", authTime: NOW }).isGuest).toBe(true);
    expect(inProcessPrincipal({ worldId: "qamin", role: "OPERATOR", authTime: NOW }).worldId).toBe("qamin");
    for (const [worldId, role] of [["demo", "OPERATOR"], ["g01", "GUEST"], ["gprobe", "OPERATOR"], ["gtest", "SUPERVISOR"], ["sim-b1", "OPERATOR"], ["qamin", "GUEST"]] as const) {
      expect(inProcessWorldAllowed(worldId, role), `${worldId} ${role}`).toBe(false);
      expect(() => inProcessPrincipal({ worldId, role, authTime: NOW })).toThrowError(expect.objectContaining({ reason: AUTH_REASON.IN_PROCESS_WORLD_DENIED }));
    }
  });
});

describe("staff directory cache", () => {
  it("reads a staff row once per minute and per user, and never caches META", async () => {
    let now = Date.parse("2026-10-07T13:10:00Z");
    const directory = createMemoryDirectory();
    directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR"));
    directory.setWorld("demo", "READY");
    const cached = withStaffCache(directory, () => new Date(now));
    expect(await cached.staff("demo", "stf-operator-01")).toMatchObject({ staffId: "stf-operator-01" });
    await cached.staff("demo", "stf-operator-01");
    expect(directory.reads.staff).toBe(1);
    now += 60_000;
    await cached.staff("demo", "stf-operator-01");
    expect(directory.reads.staff).toBe(2);
    expect(await cached.staff("demo", "stf-operator-02")).toBeUndefined();
    await cached.meta("demo");
    await cached.meta("demo");
    expect(directory.reads.meta).toBe(2);
  });
});

describe("another-session warning", () => {
  const at = (iso: string) => new Date(iso);
  it("warns about a different session active within 2 real hours, never about the same one", () => {
    const last = { sessionId: "jti-a", lastActiveAtReal: "2026-10-07T12:00:00.000Z" };
    expect(sessionPresence(last, { sessionId: "jti-b" }, at("2026-10-07T13:59:59Z")).otherSessionActive).toBe(true);
    expect(sessionPresence(last, { sessionId: "jti-b" }, at("2026-10-07T14:00:00Z")).otherSessionActive).toBe(false);
    expect(sessionPresence(last, { sessionId: "jti-a" }, at("2026-10-07T12:30:00Z")).otherSessionActive).toBe(false);
    expect(sessionPresence(undefined, { sessionId: "jti-a" }, at("2026-10-07T12:30:00Z"))).toEqual({
      otherSessionActive: false,
      next: { sessionId: "jti-a", lastActiveAtReal: "2026-10-07T12:30:00.000Z" },
    });
  });
});
