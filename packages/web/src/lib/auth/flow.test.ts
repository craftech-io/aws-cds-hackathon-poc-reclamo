import { beforeEach, describe, expect, it } from "vitest";
import { flowDeps, subOf } from "./deps";
import { type AuthFlowAction, type AuthFlowDeps, type AuthFlowState, type FlowMode, INITIAL_STATE, type Transition, advance } from "./flow";
import { createSrpClient } from "./srp";
import { FAKE_POOL_ID, FakeCognito } from "./testing/fake-cognito";
import { randomBase32Secret, totpCode } from "./testing/totp";

// Fixture passwords of a fake pool; they only ever reach the in-memory FakeCognito.
const PASSWORD = "Fixture-Password-1!";
const TEMPORARY = "Temp-Fixture-9#Aa";
const NEW_PASSWORD = "Another-Fixture-7$b";

let cognito: FakeCognito;

function deps(mode: FlowMode = { kind: "signIn" }): AuthFlowDeps {
  return flowDeps(cognito, createSrpClient(FAKE_POOL_ID), mode);
}

async function run(state: AuthFlowState, action: AuthFlowAction, mode?: FlowMode): Promise<Transition> {
  return advance(state, action, deps(mode));
}

function expectStep<S extends AuthFlowState["step"]>(transition: Transition, step: S): Extract<AuthFlowState, { step: S }> {
  expect(transition.error).toBeUndefined();
  expect(transition.state.step).toBe(step);
  return transition.state as Extract<AuthFlowState, { step: S }>;
}

beforeEach(() => {
  cognito = new FakeCognito();
});

describe("sign in with username and password (USER_SRP_AUTH) [FL-094]", () => {
  it("proves the password by SRP: the password itself never crosses the wire", async () => {
    await cognito.addUser({ username: "supervisor-01", password: PASSWORD, role: "SUPERVISOR", totpSecret: randomBase32Secret() });
    const challenge = expectStep(await run(INITIAL_STATE, { type: "signIn", username: " Supervisor-01 ", password: PASSWORD }), "totp");
    expect(challenge.challenge.login).toBe("supervisor-01");
    expect(cognito.calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of cognito.calls) expect(call.payload).not.toContain(PASSWORD);
  });

  it("signs a guest in with a username that has no email, and never enrols TOTP", async () => {
    await cognito.addUser({ username: "guest-03", password: PASSWORD, role: "GUEST", worldId: "g03" });
    const done = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "guest-03", password: PASSWORD }), "done");
    expect(done.totpVerified).toBe(false);
    expect(cognito.calls.map((call) => call.operation)).not.toContain("AssociateSoftwareToken");
  });

  it("answers a wrong password and an unknown username with the same error", async () => {
    await cognito.addUser({ username: "operator-01", password: PASSWORD });
    const wrongPassword = await run(INITIAL_STATE, { type: "signIn", username: "operator-01", password: "Wrong-Fixture-1!" });
    const unknownUser = await run(INITIAL_STATE, { type: "signIn", username: "operator-99", password: PASSWORD });
    expect(wrongPassword).toEqual({ state: INITIAL_STATE, error: "INVALID_CREDENTIALS" });
    expect(unknownUser).toEqual(wrongPassword);
  });

  it("reports an account that must reset its password as a plain rejection", async () => {
    await cognito.addUser({ username: "operator-02", password: PASSWORD });
    cognito.failNext = { operation: "InitiateAuth", type: "PasswordResetRequiredException" };
    expect((await run(INITIAL_STATE, { type: "signIn", username: "operator-02", password: PASSWORD })).error).toBe("INVALID_CREDENTIALS");
  });

  it("tells throttling and outages apart from a rejection", async () => {
    cognito.failNext = { operation: "InitiateAuth", type: "TooManyRequestsException" };
    expect((await run(INITIAL_STATE, { type: "signIn", username: "operator-01", password: PASSWORD })).error).toBe("TOO_MANY_ATTEMPTS");
    cognito.failNext = { operation: "InitiateAuth" };
    expect((await run(INITIAL_STATE, { type: "signIn", username: "operator-01", password: PASSWORD })).error).toBe("UNAVAILABLE");
  });
});

describe("first login after an invitation (NEW_PASSWORD_REQUIRED)", () => {
  it("replaces the temporary password and signs in", async () => {
    await cognito.addUser({ username: "operator-03", password: TEMPORARY, status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "operator-03", password: TEMPORARY }), "newPassword");
    expect(await run(newPassword, { type: "newPassword", password: "short" })).toEqual({ state: newPassword, error: "WEAK_PASSWORD" });
    const done = expectStep(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD }), "done");
    expect(done.tokens.refreshToken).toBeDefined();
    expectStep(await run(INITIAL_STATE, { type: "signIn", username: "operator-03", password: NEW_PASSWORD }), "done");
  });

  it("keeps the step when Cognito rejects the new password", async () => {
    await cognito.addUser({ username: "operator-04", password: TEMPORARY, status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "operator-04", password: TEMPORARY }), "newPassword");
    cognito.failNext = { operation: "RespondToAuthChallenge", type: "InvalidPasswordException" };
    expect(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD })).toEqual({ state: newPassword, error: "WEAK_PASSWORD" });
  });

  it("starts over when the challenge session expired", async () => {
    await cognito.addUser({ username: "operator-05", password: TEMPORARY, status: "FORCE_CHANGE_PASSWORD" });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "operator-05", password: TEMPORARY }), "newPassword");
    cognito.expireSessions();
    expect(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD })).toEqual({ state: INITIAL_STATE, error: "SESSION_EXPIRED" });
  });
});

describe("TOTP enrolment inside the sign-in (MFA_SETUP) and the TOTP code", () => {
  it("associates, verifies and finishes the challenge through the session, never with the access token", async () => {
    await cognito.addUser({ username: "supervisor-02", password: TEMPORARY, role: "SUPERVISOR", status: "FORCE_CHANGE_PASSWORD", mfaSetup: true });
    const newPassword = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "supervisor-02", password: TEMPORARY }), "newPassword");
    const setup = expectStep(await run(newPassword, { type: "newPassword", password: NEW_PASSWORD }), "mfaSetup");
    expect(setup.setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.setup.login).toBe("supervisor-02");
    expect(await run(setup, { type: "verifyMfaSetup", code: "000000" })).toEqual({ state: setup, error: "INVALID_CODE" });
    const done = expectStep(await run(setup, { type: "verifyMfaSetup", code: await totpCode(setup.setup.secret) }), "done");
    expect(done.totpVerified).toBe(true);
    expect(cognito.calls.map((call) => call.operation)).not.toContain("SetUserMFAPreference");

    // From now on the code is asked on every sign-in.
    const again = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "supervisor-02", password: NEW_PASSWORD }), "totp");
    expectStep(await run(again, { type: "totp", code: await cognito.currentCode("supervisor-02") }), "done");
  });

  it("rejects a wrong or malformed code and accepts the current one", async () => {
    await cognito.addUser({ username: "operator-06", password: PASSWORD, totpSecret: randomBase32Secret() });
    const totp = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "operator-06", password: PASSWORD }), "totp");
    expect(await run(totp, { type: "totp", code: "12ab" })).toEqual({ state: totp, error: "INVALID_CODE" });
    expect(await run(totp, { type: "totp", code: "000000" })).toEqual({ state: totp, error: "INVALID_CODE" });
    const code = await cognito.currentCode("operator-06");
    const done = expectStep(await run(totp, { type: "totp", code: `${code.slice(0, 3)} ${code.slice(3)}` }), "done");
    expect(done.totpVerified).toBe(true);
  });
});

describe("recent-login step-up (a fresh auth_time to approve money)", () => {
  it("signs the same person in again, whatever username the form carries", async () => {
    const user = await cognito.addUser({ username: "operator-07", password: PASSWORD, totpSecret: randomBase32Secret() });
    const mode: FlowMode = { kind: "stepUp", sub: user.sub, username: user.username };
    const totp = expectStep(await run(INITIAL_STATE, { type: "signIn", username: "intruder", password: PASSWORD }, mode), "totp");
    expect(totp.challenge.login).toBe("operator-07");
    const done = expectStep(await run(totp, { type: "totp", code: await cognito.currentCode(user.username) }, mode), "done");
    expect(subOf(done.tokens)).toBe(user.sub);
  });

  it("refuses, and revokes, a sign-in of somebody else", async () => {
    await cognito.addUser({ username: "operator-08", password: PASSWORD });
    const mode: FlowMode = { kind: "stepUp", sub: "not-the-same-sub", username: "operator-08" };
    const result = await run(INITIAL_STATE, { type: "signIn", username: "operator-08", password: PASSWORD }, mode);
    expect(result).toEqual({ state: INITIAL_STATE, error: "DIFFERENT_USER" });
    expect(cognito.revoked.size).toBe(1);
  });
});

describe("restart", () => {
  it("goes back to the credentials from any step", async () => {
    const challenge = { login: "operator-01", username: "sub", session: "s" };
    expect(await run({ step: "totp", challenge }, { type: "restart" })).toEqual({ state: INITIAL_STATE });
  });
});
