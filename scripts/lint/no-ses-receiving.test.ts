import { describe, expect, it } from "vitest";
import { findAllowedInTemplate, findInCode, findInWorkflow, scan } from "./no-ses-receiving";

interface Fixture {
  readonly sid: string;
  readonly effect: "Allow" | "Deny";
  readonly actions: readonly string[];
  readonly notAction?: readonly string[];
  readonly condition?: boolean;
}

const allow = (sid: string, actions: readonly string[]): Fixture => ({ sid, effect: "Allow", actions });
const deny = (sid: string, actions: readonly string[]): Fixture => ({ sid, effect: "Deny", actions });

function statementYaml(statement: Fixture): string[] {
  const list = (key: string, items: readonly string[]) => [`            ${key}:`, ...items.map((item) => `              - "${item}"`)];
  return [
    `          - Sid: ${statement.sid}`,
    `            Effect: ${statement.effect}`,
    ...(statement.notAction ? list("NotAction", statement.notAction) : list("Action", statement.actions)),
    '            Resource: "*"',
    ...(statement.condition ? ["            Condition:", "              StringEquals:", "                aws:RequestedRegion: us-east-1"] : []),
  ];
}

const policy = (name: string, statements: readonly Fixture[]): string[] => [
  `  ${name}:`,
  "    Type: AWS::IAM::ManagedPolicy",
  "    Properties:",
  "      PolicyDocument:",
  '        Version: "2012-10-17"',
  "        Statement:",
  ...statements.flatMap(statementYaml),
];

const role = (name: string, managed: readonly string[], boundary?: string): string[] => [
  `  ${name}:`,
  "    Type: AWS::IAM::Role",
  "    Properties:",
  ...(boundary ? [`      PermissionsBoundary: !Ref ${boundary}`] : []),
  "      ManagedPolicyArns:",
  ...managed.map((policyName) => `        - !Ref ${policyName}`),
];

const template = (resources: readonly string[][]): string => ["Resources:", ...resources.flat()].join("\n");
const lineOf = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split("\n").length;

describe("no-ses-receiving [FL-110]", () => {
  it("fails on a receipt rule, a rule set, a MAIL FROM, a Mail Manager ingress or an MX record in infra code", () => {
    const source = [
      'new aws.ses.ReceiptRule("Inbound", { ruleSetName: "x" });',
      'new aws.ses.ActiveReceiptRuleSet("Active", { ruleSetName: "x" });',
      'new aws.ses.MailFrom("Bounce", { domain: "x", mailFromDomain: "bounce.x" });',
      'new awsnative.ses.MailManagerIngressPoint("Ingress", {});',
      'new aws.route53.Record("Mx", { zoneId, name, type: "MX", records: ["10 inbound-smtp"] });',
      'new aws.route53.Record("Mx2", { zoneId, name, type: aws.route53.RecordType.MX, records });',
      'new aws.route53.Record("Mx3", { zoneId, name, type: "mx", records });',
    ].join("\n");
    expect(findInCode("infra/messaging-email.ts", source).map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("fails on a receiving API call or IAM action in runtime code, and on the v1 SES client", () => {
    expect(findInCode("x.ts", "await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName }));")).toHaveLength(1);
    expect(findInCode("x.ts", 'actions: ["ses:SetActiveReceiptRuleSet"],')).toHaveLength(1);
    expect(findInCode("x.ts", 'import { SESClient } from "@aws-sdk/client-ses";')).toHaveLength(1);
    expect(findInCode("x.ts", 'actions: ["ses:UpdateIngressPoint"],')).toHaveLength(1);
  });

  it("refuses a wildcard SES action in code, but not a wildcard resource next to its actions", () => {
    expect(findInCode("infra/x.ts", 'actions: ["ses:*"], resources: ["*"],')).toHaveLength(1);
    expect(findInCode("infra/x.ts", '{ Action: "ses:Create*", Resource: "*" }')).toHaveLength(1);
    expect(findInCode("infra/x.ts", 'permissions: [{ actions: ["*"], resources: [arn] }]')).toHaveLength(1);
    expect(findInCode("infra/x.ts", '{ actions: ["logs:PutLogEvents"], streams: "*" }')).toEqual([]);
    expect(findInCode("infra/x.ts", 'actions: ["ses:SendEmail", "ses:Get*"], resources: ["*"],')).toEqual([]);
  });

  it("accepts outbound SES and ignores comments", () => {
    const source = [
      "// no receipt rule: ADR-0003 (aws.ses.ReceiptRule is forbidden)",
      'import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";',
      'new aws.sesv2.ConfigurationSet("Email", { configurationSetName });',
      'new aws.route53.Record("Dmarc", { type: "TXT", name: "_dmarc" });',
    ].join("\n");
    expect(findInCode("infra/messaging-email.ts", source)).toEqual([]);
  });

  it("fails when a policy allows a receiving action, and accepts it denied", () => {
    const allowed = template([policy("Rules", [allow("Rules", ["ses:SetActiveReceiptRuleSet"])])]);
    const denied = template([policy("Rules", [deny("DenyRules", ["ses:*ReceiptRule*"])])]);
    expect(findAllowedInTemplate("ci-role.yaml", allowed)).toEqual([
      { file: "ci-role.yaml", line: lineOf(allowed, "Sid: Rules"), what: "Rules/Rules allows ses:SetActiveReceiptRuleSet without a Deny in the same policy set" },
    ]);
    expect(findAllowedInTemplate("ci-role.yaml", denied)).toEqual([]);
  });

  it("fails on a wildcard or NotAction grant that reaches receiving without a Deny in the role's policy set", () => {
    for (const actions of [["ses:*"], ["*"], ["ses:Create*"], ["ses:Set*"], ["ses:*Rule*"]]) {
      expect(findAllowedInTemplate("t.yaml", template([policy("Wide", [allow("Wide", actions)])])), actions.join()).not.toEqual([]);
    }
    const notAction = template([policy("Wide", [{ ...allow("Wide", []), notAction: ["iam:*"] }])]);
    expect(findAllowedInTemplate("t.yaml", notAction)).not.toEqual([]);
    expect(findAllowedInTemplate("t.yaml", template([policy("Send", [allow("Send", ["ses:SendEmail", "ses:Get*", "ses:List*"])])]))).toEqual([]);
  });

  it("accepts a wildcard grant only with an unconditional Deny on every resource in the same set", () => {
    const cover = deny("DenyReceiving", ["ses:*Receipt*", "ses:*RuleSet*", "ses:*IngressPoint*", "ses:*TrafficPolicy*", "ses:*MailFrom*"]);
    const sameRole = template([policy("Grants", [allow("Wide", ["ses:*"])]), policy("Denies", [cover]), role("Deployer", ["Grants", "Denies"])]);
    expect(findAllowedInTemplate("t.yaml", sameRole)).toEqual([]);
    const viaBoundary = template([policy("Grants", [allow("Wide", ["ses:*"])]), policy("Ceiling", [cover]), role("Deployer", ["Grants"], "Ceiling")]);
    expect(findAllowedInTemplate("t.yaml", viaBoundary)).toEqual([]);
    const otherRole = template([policy("Grants", [allow("Wide", ["ses:*"])]), policy("Denies", [cover]), role("Deployer", ["Grants"]), role("Other", ["Denies"])]);
    expect(findAllowedInTemplate("t.yaml", otherRole).map((finding) => finding.what)).toEqual([expect.stringMatching(/^Deployer\/Wide allows ses:CloneReceiptRuleSet/)]);
    const partial = template([policy("Grants", [allow("Wide", ["ses:*"]), deny("DenyRules", ["ses:*ReceiptRule*"])])]);
    expect(findAllowedInTemplate("t.yaml", partial)[0]?.what).toContain("ses:SetIdentityMailFromDomain");
    const conditional = template([policy("Grants", [allow("Wide", ["ses:*"]), { ...cover, condition: true }])]);
    expect(findAllowedInTemplate("t.yaml", conditional)).not.toEqual([]);
  });

  it("fails on an MX record in a template, in any case", () => {
    const mx = ["Resources:", "  Mx:", "    Type: AWS::Route53::RecordSet", "    Properties:", "      Name: x", '      Type: "mx"'].join("\n");
    expect(findAllowedInTemplate("t.yaml", mx)).toEqual([{ file: "t.yaml", line: 3, what: "MX record" }]);
  });

  it("fails on a workflow step about receipt rules, and ignores comments", () => {
    const step = "        run: aws ses describe-active-receipt-rule-set --query Metadata.Name";
    expect(findInWorkflow(".github/workflows/deploy.yml", step)).toHaveLength(1);
    expect(findInWorkflow(".github/workflows/deploy.yml", "# there is no step about receipt rules")).toEqual([]);
  });

  it("passes on the repository", () => {
    expect(scan(process.cwd())).toEqual([]);
  });
});
