import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// infra/dns.ts builds an SST DNS adapter when imported; the constants are all this module needs, and
// the test below checks they are the ones dns.ts declares.
vi.mock("./dns", () => ({
  appDomain: "reclamo.demo.craftech.io",
  appUrl: "https://reclamo.demo.craftech.io",
  noReplyFromAddress: "no-reply@reclamo.demo.craftech.io",
}));

const {
  INVITATION_MESSAGE_MAX_LENGTH,
  INVITATION_SMS_MAX_LENGTH,
  INVITATION_SMS_MIN_LENGTH,
  INVITATION_SUBJECT_MAX_LENGTH,
  authEmailConfiguration,
  authMailFrom,
  invitationTemplate,
  loginUrl,
  mailReady,
} = await import("./auth-email");
const { staffInvitationMail } = await import("../packages/bff/src/copy/auth-mail");

const dnsSource = readFileSync(resolve(process.cwd(), "infra/dns.ts"), "utf8");
const IDENTITY_ARN = "arn:aws:ses:us-east-1:111122223333:identity/reclamo.demo.craftech.io";
const count = (text: string, part: string): number => text.split(part).length - 1;

describe("invitation email of the staff", () => {
  it("uses the sender and the domain infra/dns.ts declares", () => {
    expect(dnsSource).toContain('export const PRODUCT_SUBDOMAIN = "reclamo";');
    expect(dnsSource).toContain("export const noReplyFromAddress = `no-reply@${appDomain}`;");
    expect(authMailFrom).toBe("Reclamo en regla <no-reply@reclamo.demo.craftech.io>");
    expect(loginUrl).toBe("https://reclamo.demo.craftech.io/login");
  });

  it("has a single source, the staff invitation of packages/bff/src/copy/auth-mail.ts", () => {
    const mail = staffInvitationMail(loginUrl);
    expect(invitationTemplate).toEqual({ emailSubject: mail.subject, emailMessage: mail.html, smsMessage: mail.sms });
  });

  it("carries the username and the temporary password once, within Cognito's limits", () => {
    const { emailSubject, emailMessage } = invitationTemplate;
    expect(count(emailMessage, "{username}")).toBe(1);
    expect(count(emailMessage, "{####}")).toBe(1);
    expect(emailSubject.length).toBeLessThanOrEqual(INVITATION_SUBJECT_MAX_LENGTH);
    expect(emailMessage.length).toBeLessThanOrEqual(INVITATION_MESSAGE_MAX_LENGTH);
    expect(emailMessage).toContain(`href="${loginUrl}"`);
  });

  it("has a non-empty SMS text with both placeholders, because CreateUserPool rejects an empty one", () => {
    const { smsMessage } = invitationTemplate;
    expect(smsMessage.length).toBeGreaterThanOrEqual(INVITATION_SMS_MIN_LENGTH);
    expect(smsMessage.length).toBeLessThanOrEqual(INVITATION_SMS_MAX_LENGTH);
    expect(count(smsMessage, "{username}")).toBe(1);
    expect(count(smsMessage, "{####}")).toBe(1);
  });

  it("brands the product, says the lender is fictional and never names another sender", () => {
    const { emailSubject, emailMessage } = invitationTemplate;
    expect(emailSubject).toContain("Reclamo en regla");
    expect(emailMessage).toContain("Reclamo en regla · Powered by Craftech");
    expect(emailMessage).toContain("prestamista ficticio");
    expect(emailMessage).toContain("100 % synthetic data");
    for (const link of emailMessage.match(/https?:\/\/[^"<\s]+/g) ?? []) expect(link.startsWith("https://reclamo.demo.craftech.io/")).toBe(true);
    expect(emailMessage).not.toMatch(/<script|on\w+=/i);
  });
});

describe("sender of the pool (docs/architecture-guests.md §2) [FL-094]", () => {
  it("keeps Cognito's default sender, with no custom FROM, while the SES identity is missing or not verified", () => {
    for (const identity of [undefined, { arn: IDENTITY_ARN, verifiedForSending: false }]) {
      const configuration = authEmailConfiguration(identity);
      expect(configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
      // The self-signup stays closed until the pool mails through SES (signup.start → SIGNUP_UNAVAILABLE).
      expect(mailReady(configuration)).toBe(false);
    }
  });

  it("sends through SES (DEVELOPER) from no-reply@ of the verified identity, without a configuration set", () => {
    const configuration = authEmailConfiguration({ arn: IDENTITY_ARN, verifiedForSending: true });
    expect(configuration).toEqual({ emailSendingAccount: "DEVELOPER", sourceArn: IDENTITY_ARN, fromEmailAddress: "Reclamo en regla <no-reply@reclamo.demo.craftech.io>" });
    expect(configuration).not.toHaveProperty("configurationSet");
    expect(mailReady(configuration)).toBe(true);
  });

  it("leaves the sending authorization policy to the identity's module, so the pool never waits for it", () => {
    const source = readFileSync(resolve(process.cwd(), "infra/auth-email.ts"), "utf8");
    expect(source).not.toMatch(/EmailIdentityPolicy|getUserPools/);
    expect(source).toContain("infra/messaging-email.ts");
  });
});
