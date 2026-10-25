// Pre-sign-up trigger (docs/architecture-guests.md §3): a self-signup only with the current request
// of that email, from the client the Bff wrote in it, and only with the `email` attribute.
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createSignupHarness, startInput, silentLogger } from "../guests/testing/harness";
import { ADMIN_CREATE_USER, SIGN_UP_DISABLED, createPreSignUpHandler } from "./pre-sign-up";

async function started(email = "ana@empresa-ficticia.ar") {
  const harness = await createSignupHarness().ready();
  // The fake pool runs the trigger inside SignUp; this reads the request it saw.
  const result = await harness.signup.start(startInput({ email }), "203.0.113.7");
  if (result.status !== "CODE_SENT") throw new Error(result.status);
  const handler = createPreSignUpHandler(() => ({
    signupRequest: (id, qa) => harness.leads.getSignup(id, qa),
    currentSignupId: (hash, qa) => harness.leads.currentSignupId(hash, qa),
    now: harness.now,
    log: silentLogger(),
  }));
  return { harness, handler, signupId: result.signupId };
}

function signUp(overrides: { userName?: string; clientId?: string; attributes?: Record<string, string>; signupId?: string } = {}): PreSignUpTriggerEvent {
  const userName = overrides.userName ?? "ana@empresa-ficticia.ar";
  return {
    version: "1",
    triggerSource: "PreSignUp_SignUp",
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName,
    callerContext: { awsSdkVersion: "x", clientId: overrides.clientId ?? "fake-guest-signup-client" },
    request: { userAttributes: overrides.attributes ?? { email: userName }, clientMetadata: overrides.signupId === undefined ? {} : { signupId: overrides.signupId } },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  } as PreSignUpTriggerEvent;
}

async function refused(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "OTHER";
  }
}

describe("pre-sign-up trigger [FL-112]", () => {
  it("lets the request's own SignUp in, without confirming or verifying anything", async () => {
    const { harness, handler, signupId } = await started();
    // The request is CODE_SENT now; the trigger saw it STARTED. Put it back to replay the call.
    await harness.store.write({ kind: "update", table: "Leads", key: { pk: `SIGNUP#${signupId}`, sk: "META" }, update: { set: { status: "STARTED" } } });
    const result = await handler(signUp({ signupId }));
    expect(result.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
  });

  it.each([
    ["the ConsoleClient", { clientId: "test-console-client" }],
    ["no request", {}],
    ["another email", { userName: "otra@empresa-ficticia.ar" }],
    ["an extra attribute", { attributes: { email: "ana@empresa-ficticia.ar", name: "Ana" } }],
    ["a custom attribute", { attributes: { email: "ana@empresa-ficticia.ar", "custom:worldId": "demo" } }],
  ])("refuses a SignUp with %s", async (_label, overrides) => {
    const { harness, handler, signupId } = await started();
    await harness.store.write({ kind: "update", table: "Leads", key: { pk: `SIGNUP#${signupId}`, sk: "META" }, update: { set: { status: "STARTED" } } });
    const withRequest = "userName" in overrides || "clientId" in overrides || "attributes" in overrides;
    expect(await refused(handler(signUp({ ...overrides, ...(withRequest ? { signupId } : {}) })))).toBe(SIGN_UP_DISABLED);
  });

  it("refuses a request that is not the current one of its email, or expired", async () => {
    const { harness, handler, signupId } = await started();
    await harness.signup.start(startInput({ email: "ana@empresa-ficticia.ar" }), "203.0.113.8");
    await harness.store.write({ kind: "update", table: "Leads", key: { pk: `SIGNUP#${signupId}`, sk: "META" }, update: { set: { status: "STARTED" } } });
    expect(await refused(handler(signUp({ signupId })))).toBe(SIGN_UP_DISABLED);
    harness.advance(49 * 3_600_000);
    expect(await refused(handler(signUp({ signupId })))).toBe(SIGN_UP_DISABLED);
  });

  it("keeps AdminCreateUser and refuses any other source", async () => {
    const { handler } = await started();
    expect((await handler({ ...signUp(), triggerSource: ADMIN_CREATE_USER } as PreSignUpTriggerEvent)).response.autoConfirmUser).toBe(false);
    expect(await refused(handler({ ...signUp(), triggerSource: "PreSignUp_ExternalProvider" } as PreSignUpTriggerEvent))).toBe(SIGN_UP_DISABLED);
  });
});
