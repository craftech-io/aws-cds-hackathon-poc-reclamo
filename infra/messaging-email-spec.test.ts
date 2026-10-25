import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findInCode } from "../scripts/lint/no-ses-receiving";
import { CAPABILITIES, LAMBDA_CAPABILITIES, stringLike } from "./iam-capabilities";
import {
  ANSWERS_FROM_ADDRESS,
  COGNITO_EMAIL_PRINCIPAL,
  COGNITO_MAIL_POLICY_NAME,
  COGNITO_SEND_ACTIONS,
  CONFIGURATION_SET,
  DKIM_KEY_LENGTH,
  DKIM_TOKEN_COUNT,
  DMARC_RECORD,
  DMARC_VALUE,
  EMAIL_DOMAIN,
  EMAIL_EVENTS,
  EMAIL_EVENT_DESTINATION,
  EMAIL_SENDER_LINK,
  NO_REPLY_FROM_ADDRESS,
  SES_REGION,
  assertEmailAddresses,
  assertExactUserPoolArn,
  assertSesRegion,
  cognitoMailPolicy,
  configurationSetName,
  defaultEventBusArn,
  dkimRecord,
  emailEventPattern,
  insideAppDomain,
  leadNoticeStatement,
  sendEmailStatement,
  sesConfigurationSetArn,
  sesIdentityArn,
  type SendStatement,
} from "./messaging-email-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const dns = read("infra/dns.ts");
const moduleSource = read("infra/messaging-email.ts");
const specSource = read("infra/messaging-email-spec.ts");
/** Source without comment lines: what the module does, not what it explains. */
const codeOf = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
const moduleCode = codeOf(moduleSource);
const ciRole = read("infra/bootstrap/ci-role.yaml");
const architecture = read("docs/architecture.md");
const integrations = read("docs/architecture-integrations.md");

const APP = "aws-cds-hackathon-poc-reclamo";
const PLACE = { account: "776805327629", region: "us-east-1" } as const;
const SET = configurationSetName(APP, "poc");
const POOL_ARN = "arn:aws:cognito-idp:us-east-1:776805327629:userpool/us-east-1_AbCd3fGh1";
const TOKENS = ["abcdefghijklmnopqrstuvwxyz234567", "bcdefghijklmnopqrstuvwxyz2345678", "cdefghijklmnopqrstuvwxyz23456789"];

const condition = (statement: SendStatement, test: string, variable: string): string[] | undefined =>
  statement.conditions.find((entry) => entry.test === test && entry.variable === variable)?.values;

/** What IAM decides for one SendEmail of a statement (no IAM simulator offline: the conditions as written). */
function allows(statement: SendStatement, request: { from?: string; recipients?: string[] }): boolean {
  for (const { test, variable, values } of statement.conditions) {
    const present = variable === "ses:FromAddress" ? request.from !== undefined : request.recipients !== undefined;
    if (test === "Null" && values[0] === "false" && !present) return false;
    if (test === "StringEquals" && variable === "ses:FromAddress" && !values.includes(request.from ?? "")) return false;
    if (test === "ForAllValues:StringLike" && !(request.recipients ?? []).every((address) => values.some((pattern) => stringLike(pattern, address)))) return false;
  }
  return true;
}

describe("domain and senders", () => {
  it("send from the app domain and the senders infra/dns.ts declares", () => {
    expect(dns).toContain('export const ZONE_NAME = "demo.craftech.io";');
    expect(dns).toContain('export const PRODUCT_SUBDOMAIN = "reclamo";');
    expect(dns).toContain("export const answersFromAddress = `respuestas@${appDomain}`;");
    expect(dns).toContain("export const noReplyFromAddress = `no-reply@${appDomain}`;");
    expect(EMAIL_DOMAIN).toBe("reclamo.demo.craftech.io");
    expect(ANSWERS_FROM_ADDRESS).toBe("respuestas@reclamo.demo.craftech.io");
    expect(NO_REPLY_FROM_ADDRESS).toBe("no-reply@reclamo.demo.craftech.io");
    expect(moduleSource).toContain("assertEmailAddresses({ domain: appDomain, answersFrom: answersFromAddress, noReplyFrom: noReplyFromAddress });");
  });

  it("fail the deploy when infra/dns.ts drifts or the provider is in another region", () => {
    expect(() => assertEmailAddresses({ domain: EMAIL_DOMAIN, answersFrom: ANSWERS_FROM_ADDRESS, noReplyFrom: NO_REPLY_FROM_ADDRESS })).not.toThrow();
    expect(() => assertEmailAddresses({ domain: "other.demo.craftech.io", answersFrom: ANSWERS_FROM_ADDRESS, noReplyFrom: NO_REPLY_FROM_ADDRESS })).toThrow(/domain/);
    expect(() => assertEmailAddresses({ domain: EMAIL_DOMAIN, answersFrom: "answers@reclamo.demo.craftech.io", noReplyFrom: NO_REPLY_FROM_ADDRESS })).toThrow(/answersFrom/);
    expect(SES_REGION).toBe("us-east-1");
    expect(() => assertSesRegion("us-east-1")).not.toThrow();
    expect(() => assertSesRegion("us-west-2")).toThrow(/us-east-1/);
  });
});

describe("identity, Easy DKIM and DMARC", () => {
  it("creates the domain identity with Easy DKIM RSA 2048 and no default configuration set", () => {
    expect(DKIM_TOKEN_COUNT).toBe(3);
    expect(DKIM_KEY_LENGTH).toBe("RSA_2048_BIT");
    expect(moduleSource).toMatch(/new aws\.sesv2\.EmailIdentity\("EmailIdentity", \{\n\s+emailIdentity: EMAIL_DOMAIN,\n\s+dkimSigningAttributes: \{ nextSigningKeyLength: DKIM_KEY_LENGTH \},\n\}\);/);
    // Cognito's emails leave without a configuration set (docs/architecture-guests.md §2): the identity binds none.
    expect(moduleCode).not.toMatch(/configurationSetAttributes|EmailIdentity\("EmailIdentity", \{[^}]*configurationSetName/);
  });

  it("publishes one CNAME per DKIM token under _domainkey of the app domain", () => {
    const records = TOKENS.map((token, index) => dkimRecord(index, token));
    expect(records.map((record) => record.logicalName)).toEqual(["EmailDkimRecord0", "EmailDkimRecord1", "EmailDkimRecord2"]);
    expect(records[0]).toEqual({
      logicalName: "EmailDkimRecord0",
      type: "CNAME",
      name: `${TOKENS[0]}._domainkey.reclamo.demo.craftech.io`,
      records: [`${TOKENS[0]}.dkim.amazonses.com`],
    });
    expect(() => dkimRecord(3, TOKENS[0] ?? "")).toThrow(/index/);
    for (const token of ["UPPERCASE0123456789", "short", "abc.def-ghi.jkl.mno", "x".repeat(65)]) expect(() => dkimRecord(0, token), token).toThrow(/token/);
  });

  it("publishes DMARC p=reject with relaxed alignment, as docs/architecture.md §1 states", () => {
    expect(DMARC_RECORD).toEqual({ logicalName: "EmailDmarc", type: "TXT", name: "_dmarc.reclamo.demo.craftech.io", records: [DMARC_VALUE] });
    expect(DMARC_VALUE).toBe("v=DMARC1; p=reject; adkim=r; aspf=r");
    expect(architecture).toContain(`\`_dmarc.reclamo.demo.craftech.io\` TXT \`${DMARC_VALUE}\``);
  });

  it("writes only CNAME and TXT records inside the app domain, which the CI role allows (and never MX)", () => {
    const records = [DMARC_RECORD, ...TOKENS.map((token, index) => dkimRecord(index, token))];
    for (const record of records) {
      expect(insideAppDomain(record.name), record.name).toBe(true);
      expect(["CNAME", "TXT"]).toContain(record.type);
    }
    expect(insideAppDomain("xreclamo.demo.craftech.io")).toBe(false);
    expect(insideAppDomain("_dmarc.demo.craftech.io")).toBe(false);
    expect(insideAppDomain("reclamo.demo.craftech.io.")).toBe(true);
    expect(ciRole).toMatch(/route53:ChangeResourceRecordSetsRecordTypes: \[A, AAAA, CNAME, TXT\]/);
    expect(ciRole).toContain("Sid: DenyMxRecords");
    expect(moduleSource).toContain("zoneId: ZONE_ID");
  });
});

describe("outbound only (ADR-0003)", () => {
  it("declares no receipt rule, rule set, filter, MAIL FROM, ingress or MX in either file", () => {
    expect(findInCode("infra/messaging-email.ts", moduleSource)).toEqual([]);
    expect(findInCode("infra/messaging-email-spec.ts", specSource)).toEqual([]);
    for (const source of [moduleSource, specSource]) {
      const code = codeOf(source);
      expect(code).not.toMatch(/Receipt|MailFrom|mailFromDomain|IngressPoint|"MX"/);
      expect(code).not.toContain("sesv2:");
    }
  });
});

describe("configuration set and events", () => {
  it("has the fixed name of docs/architecture.md §1 that the CI role fences", () => {
    expect(SET).toBe("aws-cds-hackathon-poc-reclamo-email-poc");
    expect(architecture).toContain(`| Configuration set SES | \`${SET}\` |`);
    expect(ciRole).toContain('configuration-set/${AppName}-email-${DeployStage}"');
    expect(moduleSource).toContain("configurationSetName($app.name, $app.stage)");
  });

  it("requires TLS, keeps reputation metrics, suppresses bounces and complaints and tracks nothing", () => {
    expect(CONFIGURATION_SET).toEqual({ logicalName: "EmailConfigurationSet", tlsPolicy: "REQUIRE", reputationMetrics: true, suppressedReasons: ["BOUNCE", "COMPLAINT"] });
    expect(moduleCode).not.toMatch(/trackingOptions|vdmOptions/);
  });

  it("sends the delivery events of docs/architecture-integrations.md §2 to the default bus, never opens or clicks", () => {
    expect(EMAIL_EVENTS.map((event) => event.sesType)).toEqual(["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"]);
    expect(integrations).toContain("`SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY`, `RENDERING_FAILURE`; sin `OPEN` ni `CLICK`");
    for (const event of EMAIL_EVENTS) expect(event.sesType).not.toMatch(/OPEN|CLICK|SUBSCRIPTION/);
    expect(EMAIL_EVENT_DESTINATION).toEqual({ logicalName: "EmailConfigurationSetEvents", name: "eventbridge" });
    expect(defaultEventBusArn(PLACE)).toBe("arn:aws:events:us-east-1:776805327629:event-bus/default");
    expect(moduleSource).toContain("eventBridgeDestination: { eventBusArn: emailPlace.apply(defaultEventBusArn) }");
  });

  it("gives infra/workers.ts a rule pattern that only matches SES events of this set", () => {
    const pattern = emailEventPattern(SET);
    expect(pattern.source).toEqual(["aws.ses"]);
    expect(pattern["detail-type"]).toEqual([
      "Email Sent",
      "Email Delivered",
      "Email Bounced",
      "Email Complaint Received",
      "Email Rejected",
      "Email Delivery Delayed",
      "Email Rendering Failed",
    ]);
    expect(pattern.detail.mail.tags["ses:configuration-set"]).toEqual([SET]);
  });
});

describe("SEND_EMAIL of the outbound gate (docs/architecture.md §14)", () => {
  const statement = sendEmailStatement(PLACE, SET);

  it("grants only ses:SendEmail on the identity and the app's configuration set", () => {
    expect(statement.actions).toEqual(["ses:SendEmail"]);
    expect(statement.actions).toEqual([...CAPABILITIES.SEND_EMAIL.actions]);
    expect(statement.resources).toEqual([
      "arn:aws:ses:us-east-1:776805327629:identity/reclamo.demo.craftech.io",
      "arn:aws:ses:us-east-1:776805327629:configuration-set/aws-cds-hackathon-poc-reclamo-email-poc",
    ]);
    expect(statement.resources).toEqual([sesIdentityArn(PLACE), sesConfigurationSetArn(PLACE, SET)]);
  });

  it("fences FROM to respuestas@, every recipient to the simulator or @craftech.io, with both Null guards", () => {
    expect(condition(statement, "StringEquals", "ses:FromAddress")).toEqual(["respuestas@reclamo.demo.craftech.io"]);
    expect(condition(statement, "ForAllValues:StringLike", "ses:Recipients")).toEqual(["*@simulator.amazonses.com", "*@craftech.io"]);
    expect(condition(statement, "Null", "ses:Recipients")).toEqual(["false"]);
    expect(condition(statement, "Null", "ses:FromAddress")).toEqual(["false"]);
    const fence = CAPABILITIES.SEND_EMAIL.fence;
    for (const part of ["respuestas@reclamo.demo.craftech.io", "*@simulator.amazonses.com", "*@craftech.io", "Null guard", "…-email-poc"]) expect(fence).toContain(part);
  });

  it("allows the simulator and the team, and denies anything else, a missing key or another sender", () => {
    const from = ANSWERS_FROM_ADDRESS;
    expect(allows(statement, { from, recipients: ["success+c-001@simulator.amazonses.com"] })).toBe(true);
    expect(allows(statement, { from, recipients: ["someone@craftech.io"] })).toBe(true);
    for (const address of ["someone@example.com", "x@mail.craftech.io", "x@craftech.io.example.com", "x@simulator.amazonses.com.example.com"]) {
      expect(allows(statement, { from, recipients: [address] }), address).toBe(false);
    }
    expect(allows(statement, { from, recipients: ["success@simulator.amazonses.com", "someone@example.com"] })).toBe(false);
    expect(allows(statement, { from })).toBe(false);
    expect(allows(statement, { recipients: ["success@simulator.amazonses.com"] })).toBe(false);
    expect(allows(statement, { from: NO_REPLY_FROM_ADDRESS, recipients: ["success@simulator.amazonses.com"] })).toBe(false);
  });

  it("is carried by the EmailSender Linkable, which names the set and the sender", () => {
    expect(EMAIL_SENDER_LINK).toBe("EmailSender");
    expect(moduleSource).toMatch(/new sst\.Linkable\(EMAIL_SENDER_LINK, \{\n\s+properties: \{ identity: EMAIL_DOMAIN, configurationSet: emailConfigurationSet\.configurationSetName, fromAddress: ANSWERS_FROM_ADDRESS \},/);
    expect(moduleSource).toContain("actions: [...SEND_ACTIONS]");
  });
});

describe("SEND_LEAD_NOTICE of LeadNotifier (docs/architecture-guests.md §12)", () => {
  const statement = leadNoticeStatement(PLACE);

  it("grants ses:SendEmail on the identity only, from no-reply@ to @craftech.io, with both Null guards", () => {
    expect(statement.actions).toEqual([...LAMBDA_CAPABILITIES.LeadNotifier.actions]);
    expect(statement.resources).toEqual([sesIdentityArn(PLACE)]);
    expect(condition(statement, "StringEquals", "ses:FromAddress")).toEqual([NO_REPLY_FROM_ADDRESS]);
    expect(condition(statement, "ForAllValues:StringLike", "ses:Recipients")).toEqual(["*@craftech.io"]);
    expect(condition(statement, "Null", "ses:Recipients")).toEqual(["false"]);
    expect(condition(statement, "Null", "ses:FromAddress")).toEqual(["false"]);
  });

  it("never reaches a lead, the simulator or a look-alike domain", () => {
    expect(allows(statement, { from: NO_REPLY_FROM_ADDRESS, recipients: ["sales@craftech.io"] })).toBe(true);
    for (const address of ["success+qa-1-su1@simulator.amazonses.com", "visitor@example.com", "x@mail.craftech.io"]) {
      expect(allows(statement, { from: NO_REPLY_FROM_ADDRESS, recipients: [address] }), address).toBe(false);
    }
    expect(allows(statement, { from: ANSWERS_FROM_ADDRESS, recipients: ["sales@craftech.io"] })).toBe(false);
  });
});

describe("sending authorization of the identity for Cognito (ADR-0020)", () => {
  // Phase 1: COGNITO_DEFAULT (DKIM not SUCCESS yet); phase 2: DEVELOPER (docs/architecture-guests.md §2, §12).
  describe.each(["COGNITO_DEFAULT", "DEVELOPER"] as const)("in phase %s", (phase) => {
    const policy = cognitoMailPolicy({ ...PLACE, userPoolArn: POOL_ARN });
    const statement = policy.Statement[0];

    it(`grants Cognito's email principal the two send actions on the identity (${phase})`, () => {
      expect(policy.Statement).toHaveLength(1);
      expect(statement.Effect).toBe("Allow");
      expect(statement.Principal).toEqual({ Service: COGNITO_EMAIL_PRINCIPAL });
      expect(COGNITO_EMAIL_PRINCIPAL).toBe("email.cognito-idp.amazonaws.com");
      expect(statement.Action).toEqual([...COGNITO_SEND_ACTIONS]);
      expect(statement.Action).toEqual(["ses:SendEmail", "ses:SendRawEmail"]);
      expect(statement.Resource).toBe(sesIdentityArn(PLACE));
    });

    it(`fences it to this account, the EXACT pool ARN and the no-reply sender, with no recipient fence (${phase})`, () => {
      expect(statement.Condition).toEqual({
        StringEquals: { "aws:SourceAccount": "776805327629", "ses:FromAddress": "no-reply@reclamo.demo.craftech.io" },
        ArnEquals: { "aws:SourceArn": POOL_ARN },
      });
      const text = JSON.stringify(policy);
      expect(text).not.toContain("ses:Recipients");
      expect(text).not.toContain("ArnLike");
      expect(text).not.toContain("userpool/*");
      expect(text).not.toContain("sesv2:");
    });
  });

  it("refuses a wildcard, another account, another region or anything that is not one pool", () => {
    expect(() => assertExactUserPoolArn(PLACE, POOL_ARN)).not.toThrow();
    for (const arn of [
      "arn:aws:cognito-idp:us-east-1:776805327629:userpool/*",
      "arn:aws:cognito-idp:us-east-1:776805327629:userpool/us-east-1_*",
      "arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_AbCd3fGh1",
      "arn:aws:cognito-idp:us-west-2:776805327629:userpool/us-west-2_AbCd3fGh1",
      "arn:aws:cognito-idp:us-east-1:776805327629:userpool/us-west-2_AbCd3fGh1",
      "arn:aws:cognito-idp:us-east-1:776805327629:userpool/us-east-1_AbCd3fGh1/client/x",
      "",
    ]) {
      expect(() => cognitoMailPolicy({ ...PLACE, userPoolArn: arn }), arn).toThrow(/exact ARN/);
    }
  });

  it("is built in every deploy from the pool's own ARN: the same document in both phases, no lookup, no cycle", () => {
    expect(COGNITO_MAIL_POLICY_NAME).toBe("cognito-user-pool-mail");
    expect(moduleSource).toContain('new aws.sesv2.EmailIdentityPolicy("CognitoMailPolicy", {');
    expect(moduleSource).toContain("emailIdentity: emailIdentity.emailIdentity,");
    expect(moduleSource).toContain('import("./auth").then((module) => module.userPool.arn)');
    expect(moduleSource).toContain("cognitoMailPolicy({ ...place, userPoolArn: arn })");
    // No phase branch and no name lookup: the policy never depends on the identity's verification state.
    expect(moduleCode).not.toMatch(/verifiedForSending|getEmailIdentity|getUserPools|DEVELOPER|COGNITO_DEFAULT/);
    expect(moduleCode).not.toMatch(/^import .* from "\.\/auth";$/m);
  });
});
