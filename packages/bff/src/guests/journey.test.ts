// The self-signup end to end inside the service (level U; the LF flow with the world factory is
// tests/flows/guests.flow.test.ts): the real services, triggers, repositories and caps over the memory
// engine, the fake Cognito running the real triggers, the real clock moved by the test.
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { leadsKeys } from "../leads/keys";
import { createSignupHarness, startInput } from "./testing/harness";

async function signedUp(harness: Awaited<ReturnType<ReturnType<typeof createSignupHarness>["ready"]>>, email = "ana.prospecto@empresa-ficticia.ar") {
  const started = await harness.signup.start(startInput({ email, acceptContact: true, name: "Ana", company: "Financiera Sur", utm: { source: "linkedin", campaign: "q4" } }), "203.0.113.7");
  if (started.status !== "CODE_SENT") throw new Error(`start answered ${started.status}`);
  return started.signupId;
}

describe("guest self-signup, end to end in memory [FL-112] [FL-113]", () => {
  it("creates an UNCONFIRMED account with only the request, then on the code registers lead, world, staff row and ticket once", async () => {
    const harness = await createSignupHarness().ready();
    const signupId = await signedUp(harness);

    const user = harness.cognito.user("ana.prospecto@empresa-ficticia.ar");
    expect(user?.status).toBe("UNCONFIRMED");
    const request = await harness.leads.getSignup(signupId);
    expect(request).toMatchObject({ status: "CODE_SENT", sub: user?.sub, consents: { contact: { accepted: true } } });
    expect(await harness.leads.getLead(user?.sub ?? "")).toBeUndefined();
    const mail = harness.cognito.outbox.at(-1);
    expect(mail).toMatchObject({ kind: "SIGNUP", subject: "Tu código para Reclamo en regla" });
    expect(mail?.body).toContain(mail?.code ?? "?");

    const confirmed = await harness.signup.confirm({ signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" });
    expect(confirmed).toEqual({ status: "CONFIRMED", worldStatus: "REGISTERED", email: "ana.prospecto@empresa-ficticia.ar" });

    const sub = user?.sub ?? "";
    const worldId = harness.hashes.guestWorldId(sub);
    const lead = await harness.leads.getLead(sub);
    expect(lead).toMatchObject({ worldId, email: "ana.prospecto@empresa-ficticia.ar", name: "Ana", sourcePoc: "reclamo-en-regla", utm: { source: "linkedin", campaign: "q4" } });
    expect(lead?.consents.terms.textVersion).toBe("signup-v1");
    const meta = await harness.connector.worlds.getMeta(worldId);
    expect(meta).toMatchObject({ kind: "GUEST", status: "REGISTERED", origin: "SIGNUP", template: "guest" });
    const staff = await harness.connector.worlds.getStaff(worldId, `stf-${worldId}`);
    expect(staff).toMatchObject({ role: "GUEST", cognitoSubKey: `SUB#${sub}`, active: true });
    expect(harness.invoked.worlds).toHaveLength(1);
    expect(harness.invoked.worlds[0]).toMatchObject({ kind: "WORLD_CREATE", worldId });
    expect(harness.invoked.notices).toEqual([{ leadId: sub }]);
    const ticket = await harness.store.get("Runtime", keys.runtime(worldId, "PROVISIONREQ", harness.invoked.worlds[0]?.requestId ?? ""));
    expect(ticket).toMatchObject({ status: "OPEN", attempts: 0 });
    expect((await harness.store.get("Leads", leadsKeys.canon(harness.hashes.canonHash("ana.prospecto@empresa-ficticia.ar"))))?.confirmed).toBe(1);

    // A second confirm (a double click) repeats nothing.
    expect((await harness.signup.confirm({ signupId, code: "000000" })).status).toBe("CONFIRMED");
    expect(harness.invoked.worlds).toHaveLength(1);
  });

  it("repairs the registration when the trigger did not run, exactly once", async () => {
    const harness = await createSignupHarness().ready();
    const signupId = await signedUp(harness);
    const user = harness.cognito.user("ana.prospecto@empresa-ficticia.ar");
    // Cognito confirms, but the post-confirmation trigger never registered (as if it timed out).
    if (user) (user as { status: string }).status = "CONFIRMED";
    const confirmed = await harness.signup.confirm({ signupId, code: "123456" });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(await harness.leads.getLead(user?.sub ?? "")).toBeDefined();
    expect(harness.invoked.notices).toHaveLength(1);
  });
});

describe("the confirmation is bound to the current form [FL-116]", () => {
  it("replaces an unconfirmed sign-up: one account, and the old signupId with a valid code restarts", async () => {
    const harness = await createSignupHarness().ready();
    const attacker = await signedUp(harness, "victima@empresa-ficticia.ar");
    const victim = await signedUp(harness, "victima@empresa-ficticia.ar");
    expect(victim).not.toBe(attacker);
    expect((await harness.leads.getSignup(attacker))?.status).toBe("SUPERSEDED");
    const code = harness.cognito.lastCode("victima@empresa-ficticia.ar") ?? "";
    expect(await harness.signup.confirm({ signupId: attacker, code })).toEqual({ status: "SIGNUP_RESTART" });
    expect(harness.cognito.user("victima@empresa-ficticia.ar")?.status).toBe("UNCONFIRMED");
    expect((await harness.signup.confirm({ signupId: victim, code })).status).toBe("CONFIRMED");
  });

  it("answers EMAIL_TAKEN for a confirmed account, whatever the case", async () => {
    const harness = await createSignupHarness().ready();
    const signupId = await signedUp(harness);
    await harness.signup.confirm({ signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" });
    expect(await harness.signup.start(startInput({ email: "ANA.Prospecto@Empresa-Ficticia.ar" }), "198.51.100.4")).toEqual({ status: "EMAIL_TAKEN" });
  });
});

describe("codes [FL-114] [FL-115]", () => {
  it("rejects a wrong or expired code and resends within the per-account caps", async () => {
    const harness = await createSignupHarness().ready();
    const signupId = await signedUp(harness);
    expect(await harness.signup.confirm({ signupId, code: "999999" })).toEqual({ status: "CODE_MISMATCH" });
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await harness.signup.resend({ signupId })).toEqual({ status: "CODE_SENT" });
    expect(await harness.signup.resend({ signupId })).toEqual({ status: "RATE_LIMITED" });
    harness.advance(25 * 3_600_000);
    expect(await harness.signup.confirm({ signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" })).toEqual({ status: "CODE_EXPIRED" });
  });

  it("answers CODE_SENT to a resend of an unknown request without calling Cognito", async () => {
    const harness = await createSignupHarness().ready();
    expect(await harness.signup.resend({ signupId: "abcdefghijklmnopqrstuvwxyz" })).toEqual({ status: "CODE_SENT" });
    expect(harness.cognito.calls).toEqual([]);
  });
});

describe("password recovery, only for self-signup guests [FL-122]", () => {
  it("sends a code to a guest, the same answer to anyone else, and changes the password", async () => {
    const harness = await createSignupHarness().ready();
    const signupId = await signedUp(harness);
    await harness.signup.confirm({ signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" });

    expect(await harness.password.forgot({ email: "nadie@empresa-ficticia.ar", locale: "es" }, "203.0.113.9")).toEqual({ status: "CODE_SENT_IF_EXISTS" });
    expect(await harness.password.forgot({ email: "supervisor-01", locale: "es" }, "203.0.113.9")).toEqual({ status: "CODE_SENT_IF_EXISTS" });
    expect(harness.cognito.calls.filter((call) => call === "ForgotPassword")).toEqual([]);

    expect(await harness.password.forgot({ email: "ana.prospecto@empresa-ficticia.ar", locale: "en" }, "203.0.113.9")).toEqual({ status: "CODE_SENT_IF_EXISTS" });
    const mail = harness.cognito.outbox.at(-1);
    expect(mail).toMatchObject({ kind: "RECOVERY", subject: "Your code to choose a new password" });
    expect(await harness.password.reset({ email: "ana.prospecto@empresa-ficticia.ar", code: "000000", newPassword: "Otra-Clave-Larga-2027" })).toEqual({ status: "CODE_MISMATCH" });
    expect(await harness.password.reset({ email: "ana.prospecto@empresa-ficticia.ar", code: mail?.code ?? "", newPassword: "Otra-Clave-Larga-2027" })).toEqual({ status: "PASSWORD_CHANGED" });
    expect(harness.cognito.passwordMatches("ana.prospecto@empresa-ficticia.ar", "Otra-Clave-Larga-2027")).toBe(true);
  });
});

describe("the world of a guest [FL-120] [FL-121] [FL-124]", () => {
  it("reports REGISTERED while it waits, stamps the first sign-in of a session once, and asks again for an expired world", async () => {
    const harness = await createSignupHarness().ready();
    const signupId = await signedUp(harness);
    await harness.signup.confirm({ signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" });
    const sub = harness.cognito.user("ana.prospecto@empresa-ficticia.ar")?.sub ?? "";
    const worldId = harness.hashes.guestWorldId(sub);
    const caller = { sub, worldId, sessionId: "0f8e7d6c-session" };

    expect(await harness.guestWorld.status(caller)).toEqual({ worldStatus: "REGISTERED", queuePosition: 0 });
    const firstLogin = (await harness.leads.getLead(sub))?.lastLoginAtReal;
    expect(firstLogin).toBe(harness.now().toISOString());
    harness.advance(60_000);
    await harness.guestWorld.status(caller);
    expect((await harness.leads.getLead(sub))?.lastLoginAtReal).toBe(firstLogin);

    expect(await harness.guestWorld.requestWorld(caller)).toEqual({ status: "ALREADY_ACTIVE" });
    await harness.store.write({ kind: "update", table: "Worlds", key: keys.worldMeta(worldId), update: { set: { status: "EXPIRED" } } });
    expect(await harness.guestWorld.requestWorld(caller)).toEqual({ status: "REGISTERED" });
    expect((await harness.connector.worlds.getMeta(worldId))?.status).toBe("REGISTERED");
    expect(harness.invoked.worlds).toHaveLength(2);
    await harness.store.write({ kind: "update", table: "Worlds", key: keys.worldMeta(worldId), update: { set: { status: "EXPIRED" } } });
    expect(await harness.guestWorld.requestWorld(caller)).toEqual({ status: "RATE_LIMITED" });
  });
});

describe("closed sign-up [FL-112]", () => {
  it("answers SIGNUP_UNAVAILABLE and closed until the switch opens, and never with SES unready", async () => {
    const closed = await createSignupHarness({ open: false }).ready();
    expect(await closed.signup.availability()).toEqual({ status: "closed" });
    expect(await closed.signup.start(startInput(), "203.0.113.7")).toEqual({ status: "SIGNUP_UNAVAILABLE" });
    await closed.setOpen(true);
    expect(await closed.signup.availability()).toEqual({ status: "open" });

    const noMail = await createSignupHarness({ mailReady: false }).ready();
    expect(await noMail.signup.availability()).toEqual({ status: "closed" });
    expect(noMail.cognito.calls).toEqual([]);
  });
});
