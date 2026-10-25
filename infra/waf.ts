// The two web ACLs of the guest self-signup (docs/architecture-guests.md §8, ADR-0020 §7).
//
//   <app>-<stage>-edge   CLOUDFRONT, created by the Router itself (`waf` + `transform.waf` of
//                        sst.aws.Router in infra/web.ts, which also sets the distribution's
//                        `webAclId`). Six rules, in this order:
//                          1 IpReputation       AWS managed IP reputation list (block)
//                          2 AnonymousIp        AWS managed anonymous IP list, scoped down to the
//                                               documents `/signup` and `/login/recover` and to the
//                                               public API (block). Flat on purpose: the provider models
//                                               three levels of and/or/not, and these paths are only
//                                               ever GET documents or the public procedures. Its
//                                               `HostingProviderIPList` rule only COUNTS: cloud and
//                                               hosting egress (corporate proxies, the CI runners of
//                                               SC-00) is not anonymous; `AnonymousIPList` (VPNs, Tor,
//                                               proxies) still blocks
//                          3 PublicPostRate     10 POSTs / 5 min per IP to the public API (block with a
//                                               429 and a fixed JSON body); the GET `signup.availability`
//                                               every landing visit makes does not count
//                          4 ApiRate            1,000 requests / 5 min per IP to `/api/*` (block)
//                          5 SignupChallenge    `GET /signup` and `GET /login/recover` (full navigations)
//                          6 SignupTokenGuard   POST to the public API naming `signup.start` or
//                                               `password.forgot`
//                          Rules 5 and 6 COUNT (`EDGE_CHALLENGE_ENFORCED`, infra/guest-limits.ts): WAF's
//                          interstitial cannot run under the console's CSP and the ACL has no
//                          JavaScript-integration URL. With the flag on they would Challenge (below).
//                        "Public API" = the path starts with `/api/public/` OR contains `signup.` or
//                        `password.`, after URL_DECODE and LOWERCASE: a tRPC batch puts every procedure
//                        in the path (`/api/guest.status,signup.start?batch=1`), so a STARTS_WITH on the
//                        procedure would be dodged by naming another one first.
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
// Rule 6 is a Challenge, not a Block: AWS WAF applies token labels (`awswaf:managed:token:*`) only
// with the Bot Control, ATP or ACFP managed groups, which cost per request and are not used here, so a
// Block "without a valid token" has nothing to read. A Challenge on those POSTs passes a request with
// a valid token on (it acts like Count) and answers any other with the challenge itself (HTTP 202,
// `x-amzn-waf-action: challenge`): the request never reaches the Bff.
//
// No logging configuration (it costs and keeps IPs): per-rule metrics in `AWS/WAFV2` and sampled
// requests of the last 3 hours. Cost ~US$ 19 a month (§8). Cognito Plus stays off (ADR-0020 §7).
//
// Verify (reads only, docs/architecture-guests.md §15):
//   aws --profile craftech-demos wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1
//   aws --profile craftech-demos wafv2 get-web-acl-for-resource --resource-arn <arn of the pool>

import { consoleClient, guestSignupClient, userPool } from "./auth";
import { COGNITO_WAF_LIMITS, EDGE_CHALLENGE_ENFORCED, EDGE_WAF_LIMITS, WAF_WINDOW_SECONDS } from "./guest-limits";

/** Fixed names of docs/architecture.md §1, inside the deploy role's `wafv2` fence. */
export function webAclName(app: string, stage: string, kind: "edge" | "auth"): string {
  return `${app}-${stage}-${kind}`;
}

export const PUBLIC_API_PREFIX = "/api/public/";
export const PUBLIC_API_MARKERS = ["signup.", "password."] as const;
export const TOKEN_GUARDED_PROCEDURES = ["signup.start", "password.forgot"] as const;
export const CHALLENGED_DOCUMENTS = ["/signup", "/login/recover"] as const;
export const COGNITO_SIGNUP_OPERATIONS = ["SignUp", "ConfirmSignUp", "ResendConfirmationCode", "ForgotPassword", "ConfirmForgotPassword"] as const;
export const COGNITO_SIGN_IN_OPERATIONS = ["InitiateAuth", "RespondToAuthChallenge"] as const;
export const COGNITO_OPERATION_HEADER = "x-amzn-cognito-operation-name";
export const COGNITO_CLIENT_HEADER = "x-amzn-cognito-client-id";
export const RATE_LIMITED_BODY_KEY = "rate-limited";
export const RATE_LIMITED_BODY = '{"error":"RATE_LIMITED"}';
export const IP_REPUTATION_GROUP = "AWSManagedRulesAmazonIpReputationList";
export const ANONYMOUS_IP_GROUP = "AWSManagedRulesAnonymousIpList";
/** Rules of the anonymous-IP group that only count (rule 2 above). */
export const ANONYMOUS_IP_COUNTED = ["HostingProviderIPList"] as const;

type Transform = { priority: number; type: "NONE" | "URL_DECODE" | "LOWERCASE" };
type Field = { uriPath: Record<string, never> } | { method: Record<string, never> } | { singleHeader: { name: string } };
export interface ByteMatch {
  readonly byteMatchStatement: { searchString: string; positionalConstraint: "EXACTLY" | "STARTS_WITH" | "CONTAINS"; fieldToMatch: Field; textTransformations: Transform[] };
}
export interface Managed {
  readonly managedRuleGroupStatement: {
    vendorName: "AWS";
    name: string;
    scopeDownStatement?: Statement;
    ruleActionOverrides?: ReadonlyArray<{ name: string; actionToUse: { count: Record<string, never> } }>;
  };
}
export interface RateBased {
  readonly rateBasedStatement: { limit: number; aggregateKeyType: "IP"; evaluationWindowSec: number; scopeDownStatement: Statement };
}
export type Statement = ByteMatch | Managed | RateBased | { andStatement: { statements: Statement[] } } | { orStatement: { statements: Statement[] } } | { notStatement: { statement: Statement } };

type Action =
  | { block: Record<string, never> }
  | { block: { customResponse: { responseCode: number; customResponseBodyKey: string } } }
  | { challenge: Record<string, never> }
  | { count: Record<string, never> };
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
const NORMALISED: Transform[] = [
  { priority: 0, type: "URL_DECODE" },
  { priority: 1, type: "LOWERCASE" },
];

const visibility = (prefix: string, name: string): Visibility => ({ cloudwatchMetricsEnabled: true, metricName: `${prefix}${name}`, sampledRequestsEnabled: true });
const path = (searchString: string, positionalConstraint: ByteMatch["byteMatchStatement"]["positionalConstraint"]): ByteMatch => ({
  byteMatchStatement: { searchString, positionalConstraint, fieldToMatch: { uriPath: {} }, textTransformations: NORMALISED },
});
const method = (verb: "GET" | "POST"): ByteMatch => ({ byteMatchStatement: { searchString: verb, positionalConstraint: "EXACTLY", fieldToMatch: { method: {} }, textTransformations: NONE } });
const header = (name: string, value: string): ByteMatch => ({
  byteMatchStatement: { searchString: value, positionalConstraint: "EXACTLY", fieldToMatch: { singleHeader: { name } }, textTransformations: NONE },
});
const or = (statements: Statement[]): Statement => ({ orStatement: { statements } });
const and = (statements: Statement[]): Statement => ({ andStatement: { statements } });
const managed = (name: string, scopeDownStatement?: Statement, counted: readonly string[] = []): Managed => ({
  managedRuleGroupStatement: {
    vendorName: "AWS",
    name,
    ...(scopeDownStatement === undefined ? {} : { scopeDownStatement }),
    ...(counted.length === 0 ? {} : { ruleActionOverrides: counted.map((rule) => ({ name: rule, actionToUse: { count: {} } })) }),
  },
});
const rate = (limit: number, scopeDownStatement: Statement): RateBased => ({
  rateBasedStatement: { limit, aggregateKeyType: "IP", evaluationWindowSec: WAF_WINDOW_SECONDS, scopeDownStatement },
});

/** The public API: starts with `/api/public/` or contains `signup.` / `password.` anywhere in the path. */
export const PUBLIC_API: Statement = or([path(PUBLIC_API_PREFIX, "STARTS_WITH"), ...PUBLIC_API_MARKERS.map((marker) => path(marker, "CONTAINS"))]);
export const PUBLIC_API_POST: Statement = and([method("POST"), PUBLIC_API]);
const CHALLENGED_DOCUMENT_PATHS: ByteMatch[] = CHALLENGED_DOCUMENTS.map((document) => path(document, "EXACTLY"));
export const CHALLENGED_DOCUMENT_GETS: Statement = and([method("GET"), or(CHALLENGED_DOCUMENT_PATHS)]);
/** Scope of the anonymous-IP rule: the two documents and the public API, one level deep. */
export const SIGNUP_SURFACE: Statement = or([...CHALLENGED_DOCUMENT_PATHS, path(PUBLIC_API_PREFIX, "STARTS_WITH"), ...PUBLIC_API_MARKERS.map((marker) => path(marker, "CONTAINS"))]);

const EDGE_METRICS = "ReclamoEdge";
const AUTH_METRICS = "ReclamoAuth";

/** Rules 5 and 6: Count while `EDGE_CHALLENGE_ENFORCED` is false (infra/guest-limits.ts), Challenge otherwise. */
function challengeOrCount(enforced: boolean): Action {
  return enforced ? { challenge: {} } : { count: {} };
}

/** The six rules of the edge ACL, in priority order (docs/architecture-guests.md §8). */
export function edgeWafRules(enforced: boolean = EDGE_CHALLENGE_ENFORCED): WafRule[] {
  const rules: Array<Omit<WafRule, "priority" | "visibilityConfig">> = [
    { name: "IpReputation", overrideAction: { none: {} }, statement: managed(IP_REPUTATION_GROUP) },
    { name: "AnonymousIp", overrideAction: { none: {} }, statement: managed(ANONYMOUS_IP_GROUP, SIGNUP_SURFACE, ANONYMOUS_IP_COUNTED) },
    {
      name: "PublicPostRate",
      action: { block: { customResponse: { responseCode: EDGE_WAF_LIMITS.rateLimitedStatus, customResponseBodyKey: RATE_LIMITED_BODY_KEY } } },
      statement: rate(EDGE_WAF_LIMITS.publicPostsPerIp, PUBLIC_API_POST),
    },
    { name: "ApiRate", action: { block: {} }, statement: rate(EDGE_WAF_LIMITS.apiRequestsPerIp, path("/api/", "STARTS_WITH")) },
    { name: "SignupChallenge", action: challengeOrCount(enforced), statement: CHALLENGED_DOCUMENT_GETS },
    {
      name: "SignupTokenGuard",
      action: challengeOrCount(enforced),
      statement: and([method("POST"), PUBLIC_API, or(TOKEN_GUARDED_PROCEDURES.map((procedure) => path(procedure, "CONTAINS")))]),
    },
  ];
  return rules.map((rule, priority) => ({ ...rule, priority, visibilityConfig: visibility(EDGE_METRICS, rule.name) }));
}

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

/** `transform.waf` of the Router: every value of the edge web ACL comes from this module. */
export function applyEdgeWaf(args: aws.wafv2.WebAclArgs): undefined {
  args.name = webAclName($app.name, $app.stage, "edge");
  args.scope = "CLOUDFRONT";
  args.description = "Edge of the console: reputation, anonymous IPs, rate limits and the counted signup rules.";
  args.defaultAction = { allow: {} };
  args.rules = asProviderRules(edgeWafRules());
  args.customResponseBodies = [{ key: RATE_LIMITED_BODY_KEY, contentType: "APPLICATION_JSON", content: RATE_LIMITED_BODY }];
  args.challengeConfig = { immunityTimeProperty: { immunityTime: EDGE_WAF_LIMITS.challengeImmunitySeconds } };
  args.visibilityConfig = visibility(EDGE_METRICS, "WebAcl");
}

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
