import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { COGNITO_WAF_LIMITS } from "./guest-limits";
import type { Statement, WafRule } from "./waf";
import { SHARED_EDGE_WEB_ACL } from "./web-spec";

// infra/waf.ts builds the Cognito ACL when imported: it is evaluated against recording stand-ins, and
// every rule is checked by a small evaluator of the statements it uses (byte match on a header; and,
// or, not), against the requests of docs/architecture-guests.md §8. The edge is the account's shared
// web ACL, which infra/web.ts only associates.
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
  readonly headers?: Readonly<Record<string, string>>;
}

/** Whether a statement matches; managed groups and rate rules are reduced to their scope-down. */
function matches(statement: Statement, request: Request): boolean {
  if ("andStatement" in statement) return statement.andStatement.statements.every((inner) => matches(inner, request));
  if ("orStatement" in statement) return statement.orStatement.statements.some((inner) => matches(inner, request));
  if ("notStatement" in statement) return !matches(statement.notStatement.statement, request);
  if ("rateBasedStatement" in statement) return matches(statement.rateBasedStatement.scopeDownStatement, request);
  if ("managedRuleGroupStatement" in statement) return true;
  const { searchString, fieldToMatch } = statement.byteMatchStatement;
  return request.headers?.[fieldToMatch.singleHeader.name] === searchString;
}

/** Levels of and/or/not inside a statement; the provider models three. */
function depth(statement: Statement): number {
  if ("andStatement" in statement) return 1 + Math.max(...statement.andStatement.statements.map(depth));
  if ("orStatement" in statement) return 1 + Math.max(...statement.orStatement.statements.map(depth));
  if ("notStatement" in statement) return 1 + depth(statement.notStatement.statement);
  if ("rateBasedStatement" in statement) return depth(statement.rateBasedStatement.scopeDownStatement);
  return 0;
}

let waf: typeof import("./waf");
const rule = (rules: WafRule[], name: string): WafRule => rules.find((candidate) => candidate.name === name) as WafRule;
beforeAll(async () => {
  waf = await import("./waf");
});

describe("edge web ACL (docs/architecture-guests.md §8) [FL-118] [FL-119]", () => {
  it("is the account's shared demos-borde, looked up by name and associated with the distribution, never one of this app", () => {
    expect(SHARED_EDGE_WEB_ACL).toBe("demos-borde");
    const web = readFileSync(resolve(process.cwd(), "infra/web.ts"), "utf8");
    expect(web).toContain('aws.wafv2.getWebAclOutput({ name: SHARED_EDGE_WEB_ACL, scope: "CLOUDFRONT" })');
    expect(web).toContain("args.webAclArn = sharedEdgeWebAcl.arn;");
    expect(web).not.toMatch(/\bwaf: (true|applyEdgeWaf)/);
    expect(fake.created.filter((item) => item.kind === "WebAcl").map((item) => item.args.scope)).toEqual(["REGIONAL"]);
  });
});

describe("Cognito web ACL (docs/architecture-guests.md §8) [FL-119]", () => {
  const OPERATIONS = ["SignUp", "ConfirmSignUp", "ResendConfirmationCode", "ForgotPassword", "ConfirmForgotPassword"];
  const cognito = (operation: string, clientId?: string): Request => ({
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
    expect(architecture).toContain(waf.webAclName("aws-cds-hackathon-poc-reclamo", "poc", "auth"));
    expect(architecture).toContain("demos-borde");
    for (const text of ["100 / 300 s", "`x-amzn-cognito-client-id` **≠** `GuestSignupClient`"]) expect(guests).toContain(text);
  });
});
