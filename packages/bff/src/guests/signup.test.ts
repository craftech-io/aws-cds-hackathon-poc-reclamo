// `signup.start` (docs/architecture-guests.md §4, §7): refusals that write nothing and never reach
// Cognito, the caps on the real clock, and what the request stores.
import { createHmac } from "node:crypto";
import { AdminGetUserCommand, CognitoIdentityProviderClient, ConfirmSignUpCommand, ForgotPasswordCommand, SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { leadsKeys, signupRuntimeKeys } from "../leads/keys";
import { createGuestCognito, secretHash, toCognitoFailure } from "./cognito-port";
import { SignupStartInput } from "./schemas";
import { createSignupHarness, startInput } from "./testing/harness";

const IP = "203.0.113.7";

async function allRows(harness: Awaited<ReturnType<ReturnType<typeof createSignupHarness>["ready"]>>) {
  const signup = await harness.store.query({ table: "Leads", index: "ByEmailHash", partition: `EMAIL#${harness.hashes.emailHash("ana.prospecto@empresa-ficticia.ar")}` });
  return signup.items;
}

describe("signup.start refusals [FL-112]", () => {
  it.each([
    ["CONSENT_REQUIRED", { acceptTerms: false }],
    ["WEAK_PASSWORD", { password: "cortita1A" }],
    ["WEAK_PASSWORD", { password: "sinnumerosNiMayusculas" }],
    ["INVALID_EMAIL", { email: "qa-x@empresa-ficticia.ar" }],
    ["INVALID_EMAIL", { email: "ana@nomail.ar" }],
    ["EMAIL_NOT_ACCEPTED", { email: "ana@yopmail.com" }],
  ])("answers %s, writes no request and calls no Cognito", async (status, overrides) => {
    const harness = await createSignupHarness().ready();
    expect(await harness.signup.start(startInput(overrides), IP)).toEqual({ status });
    expect(await allRows(harness)).toEqual([]);
    expect(harness.cognito.calls).toEqual([]);
  });

  it("stores both consents with the real instant and the text version, contact unticked as false", async () => {
    const harness = await createSignupHarness().ready();
    const result = await harness.signup.start(startInput(), IP);
    if (result.status !== "CODE_SENT") throw new Error(result.status);
    const request = await harness.leads.getSignup(result.signupId);
    expect(request?.consents).toEqual({ terms: { acceptedAtReal: harness.now().toISOString(), textVersion: "signup-v1" }, contact: { accepted: false, textVersion: "signup-v1" } });
    expect(request?.clientId).toBe("fake-guest-signup-client");
  });

  it("refuses links, markup and line breaks in the lead's free texts at the edge", () => {
    for (const bad of ["https://phish.example", "Ana <b>", "Ana\nBcc: x", "www.algo", "Visitá acme.com"]) {
      expect(SignupStartInput.safeParse(startInput({ name: bad })).success, bad).toBe(false);
    }
    expect(SignupStartInput.safeParse(startInput({ name: "Ana María", company: "Financiera del Sur S.A.", jobTitle: "compliance" })).success).toBe(true);
    expect(SignupStartInput.safeParse({ ...startInput(), extra: 1 }).success).toBe(false);
    expect(SignupStartInput.safeParse(startInput({ referrer: "https://buscador.ar/?q=x" })).success).toBe(false);
  });
});

describe("caps of the sign-up on the real clock [FL-118]", () => {
  it("allows 3 requests per IP per real day, then RATE_LIMITED before Cognito, and a new day opens a new window", async () => {
    const harness = await createSignupHarness().ready();
    for (let n = 1; n <= 3; n += 1) expect((await harness.signup.start(startInput({ email: `persona${n}@empresa-ficticia.ar` }), IP)).status).toBe("CODE_SENT");
    const calls = harness.cognito.calls.length;
    expect(await harness.signup.start(startInput({ email: "persona4@empresa-ficticia.ar" }), IP)).toEqual({ status: "RATE_LIMITED" });
    expect(harness.cognito.calls.length).toBe(calls);
    expect((await harness.signup.start(startInput({ email: "persona4@empresa-ficticia.ar" }), "2001:db8:1:2::9")).status).toBe("CODE_SENT");
    harness.advance(24 * 3_600_000);
    expect((await harness.signup.start(startInput({ email: "persona5@empresa-ficticia.ar" }), IP)).status).toBe("CODE_SENT");
  });

  it("one IP refused by its own cap never closes the sign-up for another IP", async () => {
    const harness = await createSignupHarness().ready();
    for (let n = 0; n < 25; n += 1) await harness.signup.start(startInput({ email: `flood${n}@empresa-ficticia.ar` }), IP);
    expect((await harness.signup.start(startInput({ email: "otra.persona@empresa-ficticia.ar" }), "198.51.100.200")).status).toBe("CODE_SENT");
  });

  it("counts an IPv6 /64 as one subscriber", async () => {
    const harness = await createSignupHarness().ready();
    for (let n = 1; n <= 3; n += 1) await harness.signup.start(startInput({ email: `v6-${n}@empresa-ficticia.ar` }), `2001:db8:aa:bb::${n}`);
    expect(await harness.signup.start(startInput({ email: "v6-4@empresa-ficticia.ar" }), "2001:db8:aa:bb:ffff::1")).toEqual({ status: "RATE_LIMITED" });
  });

  it("allows 3 requests per canonical email per day, whatever the +tag", async () => {
    const harness = await createSignupHarness().ready();
    const ips = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
    for (let n = 0; n < 3; n += 1) expect((await harness.signup.start(startInput({ email: `ana+${n}@empresa-ficticia.ar` }), ips[n] ?? IP)).status).toBe("CODE_SENT");
    expect(await harness.signup.start(startInput({ email: "ana+3@empresa-ficticia.ar" }), ips[3] ?? IP)).toEqual({ status: "RATE_LIMITED" });
  });

  it("stops at the global auth-mail cap without calling Cognito, and audits without email or IP", async () => {
    const harness = await createSignupHarness().ready();
    const hour = harness.now().toISOString().slice(0, 13);
    await harness.store.write({ kind: "put", table: "Runtime", item: { pk: `AUTHMAIL#${hour}`, sk: "META", count: 60 } });
    expect(await harness.signup.start(startInput(), IP)).toEqual({ status: "RATE_LIMITED" });
    expect(harness.cognito.calls).toEqual([]);
    const audit = await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${harness.now().toISOString().slice(0, 7)}` });
    expect(audit.items[0]).toMatchObject({ action: "SIGNUP_REJECTED", outcome: "RATE_LIMITED" });
    expect(JSON.stringify(audit.items)).not.toContain(IP);
    expect(JSON.stringify(audit.items)).not.toContain("@");
  });

  it("allows 2 confirmed accounts per canonical email in total", async () => {
    const harness = await createSignupHarness().ready();
    await harness.store.write({ kind: "put", table: "Leads", item: { pk: `CANON#${harness.hashes.canonHash("ana@empresa-ficticia.ar")}`, sk: "META", confirmed: 2 } });
    expect(await harness.signup.start(startInput({ email: "ana+nueva@empresa-ficticia.ar" }), IP)).toEqual({ status: "RATE_LIMITED" });
  });
});

describe("replacing an unconfirmed account [FL-116]", () => {
  it("deletes only an UNCONFIRMED @ username and signs up again with this form", async () => {
    const harness = await createSignupHarness().ready();
    await harness.signup.start(startInput({ password: "Primera-Clave-2026" }), IP);
    const firstSub = harness.cognito.user("ana.prospecto@empresa-ficticia.ar")?.sub;
    await harness.signup.start(startInput({ password: "Segunda-Clave-2026" }), "198.51.100.9");
    const user = harness.cognito.user("ana.prospecto@empresa-ficticia.ar");
    expect(user?.sub).not.toBe(firstSub);
    expect(user?.password).toBe("Segunda-Clave-2026");
    expect(harness.cognito.calls.filter((call) => call === "AdminDeleteUser")).toHaveLength(1);
  });
});

describe("a sign-up that failed at Cognito can be tried again [FL-116]", () => {
  it.each(["TRIGGER_REFUSED", "LIMIT_EXCEEDED", "WEAK_PASSWORD"] as const)("after %s the next start sends the code", async (code) => {
    const harness = await createSignupHarness().ready();
    harness.cognito.failNext("SignUp", code);
    const first = await harness.signup.start(startInput(), IP);
    expect(first.status).not.toBe("CODE_SENT");
    const second = await harness.signup.start(startInput(), IP);
    if (second.status !== "CODE_SENT") throw new Error(second.status);
    const email = "ana.prospecto@empresa-ficticia.ar";
    expect(await harness.leads.currentSignupId(harness.hashes.emailHash(email))).toBe(second.signupId);
    expect((await harness.leads.getSignup(second.signupId))?.status).toBe("CODE_SENT");
  });

  it("a previous request that ended after it was read does not cancel the new one", async () => {
    const harness = await createSignupHarness().ready();
    const first = await harness.signup.start(startInput(), IP);
    if (first.status !== "CODE_SENT") throw new Error(first.status);
    const stale = await harness.leads.getSignup(first.signupId);
    if (!stale) throw new Error("missing request");
    await harness.leads.abandon(stale);
    const next = { ...stale, signupId: "retryabcdefghijklmnopqrstu", status: "STARTED" as const };
    delete (next as { sub?: string }).sub;
    await harness.leads.start(next, stale);
    expect(await harness.leads.currentSignupId(stale.emailHash)).toBe("retryabcdefghijklmnopqrstu");
    expect((await harness.leads.getSignup(first.signupId))?.status).toBe("ABANDONED");
  });
});

describe("the scenario runner's sign-up, only in process with its QA scope [FL-112] [FL-113]", () => {
  const QA = { runId: "r7", key: "su1" } as const;
  const QA_EMAIL = "success+qa-r7-su1@simulator.amazonses.com";

  it("[FL-112] refuses the SES mailbox simulator to a visitor, and any other address to the QA scope", async () => {
    const harness = await createSignupHarness().ready();
    expect(await harness.signup.start(startInput({ email: QA_EMAIL }), "203.0.113.7")).toEqual({ status: "INVALID_EMAIL" });
    expect(await harness.signup.start(startInput({ email: "success+qa-r8-su1@simulator.amazonses.com" }), "203.0.113.7", QA)).toEqual({ status: "INVALID_EMAIL" });
    expect(await harness.signup.start(startInput({ email: QA_EMAIL }), "203.0.113.7", { runId: "R7!", key: "su1" })).toEqual({ status: "INVALID_EMAIL" });
    expect(harness.cognito.calls).not.toContain("SignUp");
  });

  it("[FL-113] keeps its request, world and lead under QA keys, in its own caps, and notifies no one", async () => {
    const harness = await createSignupHarness().ready();
    const started = await harness.signup.start(startInput({ email: QA_EMAIL, locale: "en" }), "203.0.113.7", QA);
    if (started.status !== "CODE_SENT") throw new Error(started.status);
    expect(await harness.store.get("Leads", leadsKeys.signup(started.signupId, QA))).toMatchObject({ status: "CODE_SENT", worldId: "qa-r7-su1" });
    expect(await harness.store.get("Leads", leadsKeys.signup(started.signupId))).toBeUndefined();
    expect(await harness.caps.count(signupRuntimeKeys.qaDay(harness.now()))).toBe(1);
    for (const key of [signupRuntimeKeys.globalDay(harness.now()), signupRuntimeKeys.authMailDay(harness.now()), signupRuntimeKeys.ipDay(harness.hashes.ipHash("203.0.113.7"), harness.now())]) {
      expect(await harness.caps.count(key)).toBe(0);
    }
    // A visitor's form never reaches a QA request.
    expect(await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode(QA_EMAIL) ?? "" })).toEqual({ status: "SIGNUP_RESTART" });

    const confirmed = await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode(QA_EMAIL) ?? "" }, QA);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", worldStatus: "REGISTERED" });
    const sub = harness.cognito.user(QA_EMAIL)?.sub ?? "";
    expect(await harness.store.get("Leads", leadsKeys.lead(sub, QA))).toMatchObject({ worldId: "qa-r7-su1", qa: QA });
    expect(await harness.store.get("Leads", leadsKeys.lead(sub))).toBeUndefined();
    expect(harness.invoked.worlds).toEqual([expect.objectContaining({ worldId: "qa-r7-su1" })]);
    expect(harness.invoked.notices).toEqual([]);
  });

  it("[FL-118] stops the QA run at its own hour cap, without touching a visitor's", async () => {
    const harness = await createSignupHarness().ready();
    await harness.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.qaHour(harness.now()), count: 20 } });
    expect(await harness.signup.start(startInput({ email: QA_EMAIL }), "203.0.113.7", QA)).toEqual({ status: "RATE_LIMITED" });
    // Its refusal is audited in the runner's own partition (the QaDriver writes only `SIGNUP#AUD#QA#*`).
    const month = harness.now().toISOString().slice(0, 7);
    expect((await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#QA#${month}` })).items).toEqual([expect.objectContaining({ action: "SIGNUP_REJECTED", outcome: "RATE_LIMITED" })]);
    expect((await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${month}` })).items).toEqual([]);
    expect((await harness.signup.start(startInput(), "203.0.113.7")).status).toBe("CODE_SENT");
  });
});

describe("the real Cognito adapter of the sign-up [FL-112] [FL-122]", () => {
  const config = { region: "us-east-1", userPoolId: "us-east-1_TESTPOOL1", clientId: "guest-signup-client", clientSecret: "test-client-secret-not-real" };
  const cognitoMock = mockClient(CognitoIdentityProviderClient);
  afterEach(() => cognitoMock.reset());
  const named = (name: string, message = name) => Object.assign(new Error(message), { name });

  it("[FL-112] signs up with the GuestSignupClient, its SECRET_HASH and only the email attribute", async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserSub: "3b7c1d2e-0000-4000-8000-00000000c001", UserConfirmed: false });
    const port = createGuestCognito(config, new CognitoIdentityProviderClient({ region: "us-east-1" }));
    expect(await port.signUp({ username: "ana@empresa-ficticia.ar", password: "Una-Clave-Larga-2026", clientMetadata: { signupId: "a".repeat(26), locale: "es" } })).toEqual({ sub: "3b7c1d2e-0000-4000-8000-00000000c001" });
    const input = cognitoMock.commandCalls(SignUpCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ ClientId: "guest-signup-client", Username: "ana@empresa-ficticia.ar", UserAttributes: [{ Name: "email", Value: "ana@empresa-ficticia.ar" }], ClientMetadata: { signupId: "a".repeat(26), locale: "es" } });
    expect(input?.SecretHash).toBe(createHmac("sha256", config.clientSecret).update("ana@empresa-ficticia.ar" + config.clientId).digest("base64"));
    expect(secretHash("ana@empresa-ficticia.ar", config.clientId, config.clientSecret)).toBe(input?.SecretHash);
  });

  it("[FL-112] maps Cognito's errors to the port's codes, and anything unknown to UNAVAILABLE", () => {
    expect(toCognitoFailure(named("CodeMismatchException")).code).toBe("CODE_MISMATCH");
    expect(toCognitoFailure(named("ExpiredCodeException")).code).toBe("CODE_EXPIRED");
    expect(toCognitoFailure(named("InvalidPasswordException")).code).toBe("WEAK_PASSWORD");
    expect(toCognitoFailure(named("UsernameExistsException")).code).toBe("USERNAME_EXISTS");
    expect(toCognitoFailure(named("UserLambdaValidationException")).code).toBe("TRIGGER_REFUSED");
    expect(toCognitoFailure(named("TooManyRequestsException")).code).toBe("LIMIT_EXCEEDED");
    expect(toCognitoFailure(named("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED")).code).toBe("ALREADY_CONFIRMED");
    expect(toCognitoFailure(named("InternalErrorException")).code).toBe("UNAVAILABLE");
    expect(toCognitoFailure(named("TimeoutError")).code).toBe("UNAVAILABLE");
  });

  it("[FL-122] reads an absent user as undefined and never calls the recovery without the secret hash", async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(named("UserNotFoundException"));
    cognitoMock.on(ForgotPasswordCommand).resolves({});
    const port = createGuestCognito(config, new CognitoIdentityProviderClient({ region: "us-east-1" }));
    expect(await port.account("nadie@empresa-ficticia.ar")).toBeUndefined();
    await port.forgotPassword({ username: "ana@empresa-ficticia.ar", clientMetadata: { locale: "en" } });
    expect(cognitoMock.commandCalls(ForgotPasswordCommand)[0]?.args[0].input).toMatchObject({ ClientId: "guest-signup-client", SecretHash: secretHash("ana@empresa-ficticia.ar", config.clientId, config.clientSecret) });
    cognitoMock.on(ConfirmSignUpCommand).rejects(named("CodeMismatchException"));
    await expect(port.confirmSignUp({ username: "ana@empresa-ficticia.ar", code: "123456", clientMetadata: {} })).rejects.toMatchObject({ name: "CognitoFailure", code: "CODE_MISMATCH" });
  });
});

