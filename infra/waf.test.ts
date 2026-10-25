import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { COGNITO_WAF_LIMITS, EDGE_CHALLENGE_ENFORCED, EDGE_WAF_LIMITS, WAF_WINDOW_SECONDS } from "./guest-limits";
import type { Managed, Statement, WafRule } from "./waf";

// infra/waf.ts builds the Cognito ACL when imported: it is evaluated against recording stand-ins, and
// every rule is checked by a small evaluator of the statements it uses (byte match on the path, the
// method or a header, with URL_DECODE and LOWERCASE; and, or, not), against the requests of
// docs/architecture-guests.md §4 and §8.
const fake = vi.hoisted(() => {
  class Out<T = unknown> {
    readonly promise: Promise<T>;
    constructor(value: unknown) {
      this.promise = Promise.resolve(value).then((resolved) => (resolved instanceof Out ? resolved.promise : resolved)) as Promise<T>;
    }
    apply<U>(fn: (value: T) => unknown): Out<U> {
      return new Out<U>(this.promise.then(fn));
    }
  }
  const created: Array<{ kind: string; name: string; args: Record<string, unknown> }> = [];
  const resource = (kind: string) =>
    class {
      readonly arn: Out<string>;
      constructor(name: string, args: Record<string, unknown>) {
        created.push({ kind, name, args });
        this.arn = new Out(`arn:test:${name}`);
      }
    };
  const globals = {
    $app: { name: "aws-cds-hackathon-poc-reclamo", stage: "poc" },
    $util: { all: (values: unknown[]) => new Out(Promise.all(values.map((value) => (value instanceof Out ? value.promise : value)))) },
    aws: { wafv2: { WebAcl: resource("WebAcl"), WebAclAssociation: resource("WebAclAssociation") } },
  };
  return { Out, created, globals };
});

vi.mock("./auth", () => ({
  userPool: { arn: new fake.Out("arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_Pool") },
  consoleClient: { id: new fake.Out("console-client") },
  guestSignupClient: { id: new fake.Out("guest-client") },
}));
for (const [name, value] of Object.entries(fake.globals)) Reflect.set(globalThis, name, value);

interface Request {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function transform(value: string, transforms: ReadonlyArray<{ type: string }>): string {
  return transforms.reduce((text, { type }) => (type === "URL_DECODE" ? decodeURIComponent(text) : type === "LOWERCASE" ? text.toLowerCase() : text), value);
}

/** Whether a statement matches; managed groups and rate rules are reduced to their scope-down. */
function matches(statement: Statement, request: Request): boolean {
  if ("andStatement" in statement) return statement.andStatement.statements.every((inner) => matches(inner, request));
  if ("orStatement" in statement) return statement.orStatement.statements.some((inner) => matches(inner, request));
  if ("notStatement" in statement) return !matches(statement.notStatement.statement, request);
  if ("rateBasedStatement" in statement) return matches(statement.rateBasedStatement.scopeDownStatement, request);
  if ("managedRuleGroupStatement" in statement) {
    const scope = statement.managedRuleGroupStatement.scopeDownStatement;
    return scope === undefined || matches(scope, request);
  }
  const { searchString, positionalConstraint, fieldToMatch, textTransformations } = statement.byteMatchStatement;
  const raw = "uriPath" in fieldToMatch ? request.url.split("?")[0] ?? "" : "method" in fieldToMatch ? request.method : request.headers?.[fieldToMatch.singleHeader.name];
  if (raw === undefined) return false;
  const value = transform(raw, textTransformations);
  if (positionalConstraint === "EXACTLY") return value === searchString;
  return positionalConstraint === "STARTS_WITH" ? value.startsWith(searchString) : value.includes(searchString);
}

/** Levels of and/or/not inside a statement; the provider models three. */
function depth(statement: Statement): number {
  if ("andStatement" in statement) return 1 + Math.max(...statement.andStatement.statements.map(depth));
  if ("orStatement" in statement) return 1 + Math.max(...statement.orStatement.statements.map(depth));
  if ("notStatement" in statement) return 1 + depth(statement.notStatement.statement);
  if ("rateBasedStatement" in statement) return depth(statement.rateBasedStatement.scopeDownStatement);
  if ("managedRuleGroupStatement" in statement) return statement.managedRuleGroupStatement.scopeDownStatement ? depth(statement.managedRuleGroupStatement.scopeDownStatement) : 0;
  return 0;
}

let waf: typeof import("./waf");
const rule = (rules: WafRule[], name: string): WafRule => rules.find((candidate) => candidate.name === name) as WafRule;
beforeAll(async () => {
  waf = await import("./waf");
});

describe("edge web ACL (docs/architecture-guests.md §8) [FL-118] [FL-119]", () => {
  it("has the six rules in order, with their actions", () => {
    const rules = waf.edgeWafRules();
    expect(rules.map(({ name, priority }) => [priority, name])).toEqual([
      [0, "IpReputation"],
      [1, "AnonymousIp"],
      [2, "PublicPostRate"],
      [3, "ApiRate"],
      [4, "SignupChallenge"],
      [5, "SignupTokenGuard"],
    ]);
    expect(rule(rules, "IpReputation").statement).toEqual({ managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } });
    expect(rule(rules, "AnonymousIp").overrideAction).toEqual({ none: {} });
    expect(rule(rules, "PublicPostRate").action).toEqual({ block: { customResponse: { responseCode: 429, customResponseBodyKey: "rate-limited" } } });
    expect(rule(rules, "ApiRate").action).toEqual({ block: {} });
    // Count on poc: the interstitial cannot run under the console's CSP (infra/guest-limits.ts).
    expect(EDGE_CHALLENGE_ENFORCED).toBe(false);
    for (const name of ["SignupChallenge", "SignupTokenGuard"]) expect(rule(rules, name).action, name).toEqual({ count: {} });
    for (const { statement, name } of rules) expect(depth(statement), name).toBeLessThanOrEqual(3);
  });

  it("limits POSTs to the public API to 10 and the API to 1,000 per IP every 5 minutes", () => {
    expect(EDGE_WAF_LIMITS).toMatchObject({ publicPostsPerIp: 10, apiRequestsPerIp: 1_000, rateLimitedStatus: 429 });
    const rules = waf.edgeWafRules();
    for (const [name, limit] of [["PublicPostRate", 10], ["ApiRate", 1_000]] as const) {
      expect(rule(rules, name).statement).toMatchObject({ rateBasedStatement: { limit, aggregateKeyType: "IP", evaluationWindowSec: 300 } });
    }
    expect(WAF_WINDOW_SECONDS).toBe(300);
  });

  it("treats a path that contains signup. or password. as the public API, so a tRPC batch cannot hide one", () => {
    const publicPost = rule(waf.edgeWafRules(), "PublicPostRate").statement;
    for (const url of ["/api/public/signup.start", "/api/guest.status,signup.start?batch=1", "/api/inbox.list,password.forgot", "/api/%73ignup.start", "/api/SIGNUP.Start", "/api/public/anything"]) {
      expect(matches(publicPost, { method: "POST", url }), url).toBe(true);
    }
    for (const url of ["/api/inbox.list", "/api/account.changePassword", "/signup"]) expect(matches(publicPost, { method: "POST", url }), url).toBe(false);
    // The availability query every landing visit makes is a GET: it never counts against the 10.
    expect(matches(publicPost, { method: "GET", url: "/api/public/signup.availability" })).toBe(false);
  });

  it("only counts hosting-provider IPs (CI runners, cloud egress) and keeps blocking anonymous ones", () => {
    const statement = rule(waf.edgeWafRules(), "AnonymousIp").statement as Managed;
    expect(statement.managedRuleGroupStatement.name).toBe("AWSManagedRulesAnonymousIpList");
    expect(statement.managedRuleGroupStatement.ruleActionOverrides).toEqual([{ name: "HostingProviderIPList", actionToUse: { count: {} } }]);
    expect(statement.managedRuleGroupStatement.ruleActionOverrides?.map((override) => override.name)).not.toContain("AnonymousIPList");
    expect(rule(waf.edgeWafRules(), "IpReputation").statement).not.toHaveProperty("managedRuleGroupStatement.ruleActionOverrides");
  });

  it("blocks anonymous IPs on the signup documents and the public API only", () => {
    const anonymous = rule(waf.edgeWafRules(), "AnonymousIp").statement;
    for (const url of ["/signup", "/login/recover", "/api/public/signup.start", "/api/guest.status,signup.start?batch=1"]) expect(matches(anonymous, { method: "GET", url }), url).toBe(true);
    for (const url of ["/", "/login", "/app/inbox", "/api/inbox.list"]) expect(matches(anonymous, { method: "GET", url }), url).toBe(false);
  });

  it("challenges the full navigations to /signup and /login/recover, and only those", () => {
    const challenge = rule(waf.edgeWafRules(), "SignupChallenge").statement;
    expect(matches(challenge, { method: "GET", url: "/signup" })).toBe(true);
    expect(matches(challenge, { method: "GET", url: "/login/recover" })).toBe(true);
    for (const request of [{ method: "GET", url: "/signup/verify" }, { method: "POST", url: "/signup" }, { method: "GET", url: "/login" }] as const) expect(matches(challenge, request), request.url).toBe(false);
  });

  it("stops a POST of signup.start or password.forgot without a valid token at the edge, in a batch too", () => {
    const guard = rule(waf.edgeWafRules(), "SignupTokenGuard");
    for (const url of ["/api/public/signup.start", "/api/public/password.forgot", "/api/guest.status,signup.start?batch=1"]) expect(matches(guard.statement, { method: "POST", url }), url).toBe(true);
    for (const url of ["/api/public/signup.confirm", "/api/public/password.reset", "/api/inbox.list"]) expect(matches(guard.statement, { method: "POST", url }), url).toBe(false);
    expect(matches(guard.statement, { method: "GET", url: "/api/public/signup.start" })).toBe(false);
  });

  it("challenges rules 5 and 6 only with the constant on, keeping the rest", () => {
    const challenged = waf.edgeWafRules(true);
    for (const name of ["SignupChallenge", "SignupTokenGuard"]) expect(rule(challenged, name).action, name).toEqual({ challenge: {} });
    expect(rule(challenged, "PublicPostRate").action).toEqual(rule(waf.edgeWafRules(false), "PublicPostRate").action);
  });

  it("is the Router's own ACL, named <app>-poc-edge, with the 429 body and an hour of challenge immunity", () => {
    const args: Record<string, unknown> = {};
    waf.applyEdgeWaf(args as never);
    expect(args).toMatchObject({ name: "aws-cds-hackathon-poc-reclamo-poc-edge", scope: "CLOUDFRONT", defaultAction: { allow: {} } });
    expect(args.customResponseBodies).toEqual([{ key: "rate-limited", contentType: "APPLICATION_JSON", content: '{"error":"RATE_LIMITED"}' }]);
    expect(args.challengeConfig).toEqual({ immunityTimeProperty: { immunityTime: EDGE_WAF_LIMITS.challengeImmunitySeconds } });
    expect(args).not.toHaveProperty("loggingConfiguration");
    const web = readFileSync(resolve(process.cwd(), "infra/web.ts"), "utf8");
    expect(web).toContain("waf: true,");
    expect(web).toContain("waf: applyEdgeWaf,");
  });
});

describe("Cognito web ACL (docs/architecture-guests.md §8) [FL-119]", () => {
  const OPERATIONS = ["SignUp", "ConfirmSignUp", "ResendConfirmationCode", "ForgotPassword", "ConfirmForgotPassword"];
  const cognito = (operation: string, clientId?: string): Request => ({
    method: "POST",
    url: "/",
    headers: { "x-amzn-cognito-operation-name": operation, ...(clientId === undefined ? {} : { "x-amzn-cognito-client-id": clientId }) },
  });

  it("has the three rules in order", () => {
    const rules = waf.cognitoWafRules("guest-client", "console-client");
    expect(rules.map(({ name, priority, action, overrideAction }) => [priority, name, action ?? overrideAction])).toEqual([
      [0, "SignupOpsOnlyFromGuestClient", { block: {} }],
      [1, "SignInRate", { block: {} }],
      [2, "IpReputation", { none: {} }],
    ]);
    for (const { statement, name } of rules) expect(depth(statement), name).toBeLessThanOrEqual(3);
  });

  it("blocks the five sign-up and recovery operations for every client but the GuestSignupClient (a negative list)", () => {
    const block = rule(waf.cognitoWafRules("guest-client", "console-client"), "SignupOpsOnlyFromGuestClient").statement;
    for (const operation of OPERATIONS) {
      // ForgotPassword straight to Cognito with the ServerClient (its id is not secret) is blocked too.
      for (const client of ["console-client", "server-client", "a-future-client", undefined]) expect(matches(block, cognito(operation, client)), `${operation} ${client}`).toBe(true);
      expect(matches(block, cognito(operation, "guest-client")), operation).toBe(false);
    }
    for (const operation of ["InitiateAuth", "RespondToAuthChallenge", "RevokeToken"]) expect(matches(block, cognito(operation, "console-client")), operation).toBe(false);
  });

  it("rate-limits the ConsoleClient's sign-in to 100 per IP every 5 minutes", () => {
    const rate = rule(waf.cognitoWafRules("guest-client", "console-client"), "SignInRate");
    expect(COGNITO_WAF_LIMITS.signInsPerIp).toBe(100);
    expect(rate.statement).toMatchObject({ rateBasedStatement: { limit: 100, aggregateKeyType: "IP", evaluationWindowSec: 300 } });
    expect(matches(rate.statement, cognito("InitiateAuth", "console-client"))).toBe(true);
    expect(matches(rate.statement, cognito("RespondToAuthChallenge", "console-client"))).toBe(true);
    expect(matches(rate.statement, cognito("InitiateAuth", "guest-client"))).toBe(false);
  });

  it("is <app>-poc-auth, REGIONAL, built from the real client ids and associated with the user pool", async () => {
    const acl = fake.created.find((item) => item.kind === "WebAcl");
    expect(acl?.args).toMatchObject({ name: "aws-cds-hackathon-poc-reclamo-poc-auth", scope: "REGIONAL", defaultAction: { allow: {} } });
    const rules = (await (acl?.args.rules as InstanceType<typeof fake.Out>).promise) as WafRule[];
    expect(rules).toEqual(waf.cognitoWafRules("guest-client", "console-client"));
    const association = fake.created.find((item) => item.kind === "WebAclAssociation");
    expect(await (association?.args.resourceArn as InstanceType<typeof fake.Out>).promise).toBe("arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_Pool");
    expect(await (association?.args.webAclArn as InstanceType<typeof fake.Out>).promise).toBe("arn:test:CognitoWebAcl");
  });

  it("matches the fixed names of docs/architecture.md §1 and the numbers of docs/architecture-guests.md §8", () => {
    const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
    const guests = readFileSync(resolve(process.cwd(), "docs/architecture-guests.md"), "utf8");
    for (const kind of ["edge", "auth"] as const) expect(architecture).toContain(waf.webAclName("aws-cds-hackathon-poc-reclamo", "poc", kind));
    for (const text of ["10 / 300 s", "1.000 / 300 s", "100 / 300 s", "`x-amzn-cognito-client-id` **≠** `GuestSignupClient`"]) expect(guests).toContain(text);
  });
});
