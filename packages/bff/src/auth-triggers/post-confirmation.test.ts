// Post-confirmation trigger (docs/architecture-guests.md §3, §5): registers only from the request of
// `clientMetadata.signupId` that carries this `sub`, once, and audits a mismatch without the email.
import { describe, expect, it } from "vitest";
import { createSignupHarness, startInput, silentLogger } from "../guests/testing/harness";
import { onConfirmation } from "./post-confirmation";

async function codeSent(email = "ana@empresa-ficticia.ar") {
  const harness = await createSignupHarness().ready();
  const result = await harness.signup.start(startInput({ email }), "203.0.113.7");
  if (result.status !== "CODE_SENT") throw new Error(result.status);
  const request = await harness.leads.getSignup(result.signupId);
  return { harness, signupId: result.signupId, sub: request?.sub ?? "" };
}

function confirmation(sub: string, signupId: string | undefined, userName = "ana@empresa-ficticia.ar") {
  return { triggerSource: "PostConfirmation_ConfirmSignUp", userName, request: { userAttributes: { sub, email: userName }, ...(signupId ? { clientMetadata: { signupId } } : {}) } };
}

describe("post-confirmation trigger [FL-113] [FL-116]", () => {
  it("registers once: a second run changes nothing and invokes nothing", async () => {
    const { harness, signupId, sub } = await codeSent();
    const deps = { ctx: harness.ctx, connector: harness.connector, leads: harness.leads, invoker: harness.deps.invoker, log: silentLogger() };
    expect(await onConfirmation(confirmation(sub, signupId), deps)).toBe("REGISTERED");
    expect(await onConfirmation(confirmation(sub, signupId), deps)).toBe("ALREADY_REGISTERED");
    expect(harness.invoked.worlds).toHaveLength(1);
    expect(harness.invoked.notices).toHaveLength(1);
  });

  it("registers nothing for a signupId whose request is of another sub, and audits SIGNUP_MISMATCH without the email", async () => {
    const { harness, signupId } = await codeSent();
    const other = await harness.signup.start(startInput({ email: "otra@empresa-ficticia.ar" }), "203.0.113.8");
    if (other.status !== "CODE_SENT") throw new Error(other.status);
    const otherSub = (await harness.leads.getSignup(other.signupId))?.sub ?? "";
    const deps = { ctx: harness.ctx, connector: harness.connector, leads: harness.leads, invoker: harness.deps.invoker, log: silentLogger() };
    expect(await onConfirmation(confirmation(otherSub, signupId, "otra@empresa-ficticia.ar"), deps)).toBe("MISMATCH");
    expect(await onConfirmation(confirmation(otherSub, undefined, "otra@empresa-ficticia.ar"), deps)).toBe("MISMATCH");
    expect(await harness.leads.getLead(otherSub)).toBeUndefined();
    expect(harness.invoked.worlds).toEqual([]);
    const audit = await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${harness.now().toISOString().slice(0, 7)}` });
    expect(audit.items.map((item) => item.outcome)).toEqual(["SIGNUP_MISMATCH", "SIGNUP_MISMATCH"]);
    expect(JSON.stringify(audit.items)).not.toContain("@");
  });

  it("ignores staff and QA users created by an administrator", async () => {
    const { harness } = await codeSent();
    const deps = { ctx: harness.ctx, connector: harness.connector, leads: harness.leads, invoker: harness.deps.invoker, log: silentLogger() };
    expect(await onConfirmation(confirmation("sub-x", undefined, "operator-01"), deps)).toBe("NOT_A_SIGNUP");
  });

  it("never registers the account in a Cognito group: the role lives only in its staff row", async () => {
    const { harness, signupId, sub } = await codeSent();
    const deps = { ctx: harness.ctx, connector: harness.connector, leads: harness.leads, invoker: harness.deps.invoker, log: silentLogger() };
    await onConfirmation(confirmation(sub, signupId), deps);
    expect(harness.cognito.calls.some((call) => call.includes("Group"))).toBe(false);
  });
});
