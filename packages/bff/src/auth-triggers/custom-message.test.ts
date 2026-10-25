// Custom-message trigger (docs/architecture-guests.md §9): the texts of copy/auth-mail.ts per source
// and language, always with the code placeholder, never a link in the codes.
import type { CustomMessageTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { handler } from "./custom-message";

function event(triggerSource: string, locale?: string): CustomMessageTriggerEvent {
  return {
    version: "1",
    triggerSource,
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: "ana@empresa-ficticia.ar",
    callerContext: { awsSdkVersion: "x", clientId: "c" },
    request: { userAttributes: {}, codeParameter: "{####}", usernameParameter: "{username}", linkParameter: null, ...(locale ? { clientMetadata: { locale } } : {}) },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  } as unknown as CustomMessageTriggerEvent;
}

describe("custom message [FL-112] [FL-122]", () => {
  it.each([
    ["CustomMessage_SignUp", "es", "Tu código para Reclamo en regla"],
    ["CustomMessage_ResendCode", "en", "Your Reclamo en regla code"],
    ["CustomMessage_ForgotPassword", "es", "Tu código para elegir una nueva contraseña"],
    ["CustomMessage_ForgotPassword", "en", "Your code to choose a new password"],
  ])("%s in %s: fixed subject, the code, no link", async (source, locale, subject) => {
    const result = await handler(event(source, locale));
    expect(result.response.emailSubject).toBe(subject);
    expect(result.response.emailMessage).toContain("{####}");
    expect(result.response.emailMessage).not.toMatch(/https?:|href/);
  });

  it("writes Spanish when the sign-up did not say", async () => {
    expect((await handler(event("CustomMessage_SignUp"))).response.emailSubject).toBe("Tu código para Reclamo en regla");
  });

  it("keeps the staff invitation with the username and the temporary password", async () => {
    const result = await handler(event("CustomMessage_AdminCreateUser"));
    expect(result.response.emailMessage).toContain("{username}");
    expect(result.response.emailMessage).toContain("{####}");
  });

  it("answers any other source with a neutral text and the code", async () => {
    const result = await handler(event("CustomMessage_UpdateUserAttribute", "en"));
    expect(result.response.emailMessage).toContain("{####}");
  });
});
