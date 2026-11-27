// The web ACL of the guest self-signup that is this app's own (docs/architecture-guests.md §8, ADR-0020 §7).
// The edge (CLOUDFRONT) is the account's shared `demos-borde`, created by the `craftech/demos` project and
// only associated by infra/web.ts; the app's former edge ACL `<app>-<stage>-edge` is gone.
//
//   <app>-<stage>-auth   REGIONAL, associated with the console user pool. Three rules:
//                          1 SignupOpsOnlyFromGuestClient  `x-amzn-cognito-operation-name` ∈ {SignUp,
//                                               ConfirmSignUp, ResendConfirmationCode, ForgotPassword,
//                                               ConfirmForgotPassword} with `x-amzn-cognito-client-id`
//                                               ≠ GuestSignupClient → block. A NEGATIVE list: the
//                                               ConsoleClient, the ServerClient (its id is not secret and
//                                               those operations need no IAM), any future client and a
//                                               missing header are all blocked
//                          2 SignInRate         100 InitiateAuth + RespondToAuthChallenge of the
//                                               ConsoleClient / 5 min per IP (block)
//                          3 IpReputation       AWS managed IP reputation list (block)
//
// No logging configuration: per-rule metrics in `AWS/WAFV2` and sampled requests of the last 3 hours.
//
// Verify (reads only, docs/architecture-guests.md §15):
//   aws --profile craftech-demos wafv2 get-web-acl-for-resource --resource-arn <arn of the pool>

import { consoleClient, guestSignupClient, userPool } from "./auth";
import { COGNITO_WAF_LIMITS, WAF_WINDOW_SECONDS } from "./guest-limits";

/** Fixed names of docs/architecture.md §1, inside the deploy role's `wafv2` fence. */
export function webAclName(app: string, stage: string, kind: "auth"): string {
  return `${app}-${stage}-${kind}`;
}

export const COGNITO_SIGNUP_OPERATIONS = ["SignUp", "ConfirmSignUp", "ResendConfirmationCode", "ForgotPassword", "ConfirmForgotPassword"] as const;
export const COGNITO_SIGN_IN_OPERATIONS = ["InitiateAuth", "RespondToAuthChallenge"] as const;
export const COGNITO_OPERATION_HEADER = "x-amzn-cognito-operation-name";
export const COGNITO_CLIENT_HEADER = "x-amzn-cognito-client-id";
export const IP_REPUTATION_GROUP = "AWSManagedRulesAmazonIpReputationList";

type Transform = { priority: number; type: "NONE" };
type Field = { singleHeader: { name: string } };
export interface ByteMatch {
  readonly byteMatchStatement: { searchString: string; positionalConstraint: "EXACTLY"; fieldToMatch: Field; textTransformations: Transform[] };
}
export interface Managed {
  readonly managedRuleGroupStatement: { vendorName: "AWS"; name: string };
}
export interface RateBased {
  readonly rateBasedStatement: { limit: number; aggregateKeyType: "IP"; evaluationWindowSec: number; scopeDownStatement: Statement };
}
export type Statement = ByteMatch | Managed | RateBased | { andStatement: { statements: Statement[] } } | { orStatement: { statements: Statement[] } } | { notStatement: { statement: Statement } };

type Action = { block: Record<string, never> };
type Visibility = { cloudwatchMetricsEnabled: true; metricName: string; sampledRequestsEnabled: true };

export interface WafRule {
  readonly name: string;
  readonly priority: number;
  readonly action?: Action;
  readonly overrideAction?: { none: Record<string, never> };
  readonly statement: Statement;
  readonly visibilityConfig: Visibility;
}

const NONE: Transform[] = [{ priority: 0, type: "NONE" }];
const visibility = (prefix: string, name: string): Visibility => ({ cloudwatchMetricsEnabled: true, metricName: `${prefix}${name}`, sampledRequestsEnabled: true });
const header = (name: string, value: string): ByteMatch => ({
  byteMatchStatement: { searchString: value, positionalConstraint: "EXACTLY", fieldToMatch: { singleHeader: { name } }, textTransformations: NONE },
});
const or = (statements: Statement[]): Statement => ({ orStatement: { statements } });
const and = (statements: Statement[]): Statement => ({ andStatement: { statements } });
const managed = (name: string): Managed => ({ managedRuleGroupStatement: { vendorName: "AWS", name } });
const rate = (limit: number, scopeDownStatement: Statement): RateBased => ({
  rateBasedStatement: { limit, aggregateKeyType: "IP", evaluationWindowSec: WAF_WINDOW_SECONDS, scopeDownStatement },
});

const AUTH_METRICS = "ReclamoAuth";

/** The three rules of the Cognito ACL, in priority order (docs/architecture-guests.md §8). */
export function cognitoWafRules(guestClientId: string, consoleClientId: string): WafRule[] {
  const operation = (names: readonly string[]): Statement => or(names.map((name) => header(COGNITO_OPERATION_HEADER, name)));
  const rules: Array<Omit<WafRule, "priority" | "visibilityConfig">> = [
    {
      name: "SignupOpsOnlyFromGuestClient",
      action: { block: {} },
      statement: and([operation(COGNITO_SIGNUP_OPERATIONS), { notStatement: { statement: header(COGNITO_CLIENT_HEADER, guestClientId) } }]),
    },
    {
      name: "SignInRate",
      action: { block: {} },
      statement: rate(COGNITO_WAF_LIMITS.signInsPerIp, and([operation(COGNITO_SIGN_IN_OPERATIONS), header(COGNITO_CLIENT_HEADER, consoleClientId)])),
    },
    { name: "IpReputation", overrideAction: { none: {} }, statement: managed(IP_REPUTATION_GROUP) },
  ];
  return rules.map((rule, priority) => ({ ...rule, priority, visibilityConfig: visibility(AUTH_METRICS, rule.name) }));
}

// The provider types every nesting level of a statement as its own interface (`…ScopeDownStatement…`);
// the shapes above are the same JSON, checked rule by rule by waf.test.ts, so they are handed over as is.
type ProviderRules = aws.types.input.wafv2.WebAclRule[];
const asProviderRules = (rules: WafRule[]): ProviderRules => rules as unknown as ProviderRules;

export const cognitoWebAcl = new aws.wafv2.WebAcl("CognitoWebAcl", {
  name: webAclName($app.name, $app.stage, "auth"),
  scope: "REGIONAL",
  description: "Console user pool: sign-up and recovery only through the confidential client, sign-in rate, reputation.",
  defaultAction: { allow: {} },
  rules: $util.all([guestSignupClient.id, consoleClient.id]).apply(([guestId, consoleId]) => asProviderRules(cognitoWafRules(guestId, consoleId))),
  visibilityConfig: visibility(AUTH_METRICS, "WebAcl"),
});

export const cognitoWebAclAssociation = new aws.wafv2.WebAclAssociation("CognitoWebAclAssociation", {
  resourceArn: userPool.arn,
  webAclArn: cognitoWebAcl.arn,
});
