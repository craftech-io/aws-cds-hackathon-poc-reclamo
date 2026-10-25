import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StaffRole, WORLD_ID_MAX_LENGTH } from "@reclamo/shared";
import { type Access, LEADS_GRANTS, type TableName, WORLD_LEADING_KEYS, expectedActions, expectedBuckets, expectedTables, stringLike } from "./iam-capabilities";
import { TABLE_ACTIONS } from "./storage-keys";

// infra/auth.ts only runs inside the SST program. The test evaluates it against recording stand-ins
// of the SST and Pulumi globals, so every assertion below is on the arguments the pool, its clients,
// groups and triggers really receive (docs/architecture.md §11), not on the source text.
const fake = vi.hoisted(() => {
  class Out<T = unknown> {
    readonly promise: Promise<T>;
    constructor(value: unknown) {
      this.promise = settle(value) as Promise<T>;
      this.promise.catch(() => undefined);
    }
    apply<U>(fn: (value: T) => unknown): Out<U> {
      return new Out<U>(this.promise.then(fn));
    }
  }
  async function settle(value: unknown): Promise<unknown> {
    const awaited: unknown = await value;
    return awaited instanceof Out ? awaited.promise : awaited;
  }
  /** Resolves every Out and promise inside a value, for assertions. */
  async function deep(value: unknown): Promise<unknown> {
    const awaited = await settle(value);
    if (Array.isArray(awaited)) return Promise.all(awaited.map(deep));
    if (awaited !== null && typeof awaited === "object" && Object.getPrototypeOf(awaited) === Object.prototype) {
      const entries = await Promise.all(Object.entries(awaited).map(async ([key, item]) => [key, await deep(item)] as const));
      return Object.fromEntries(entries);
    }
    return awaited;
  }

  interface Recorded {
    readonly kind: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }
  const created: Recorded[] = [];
  const ses: { identity: { arn: string; verifiedForSendingStatus: boolean } | undefined } = { identity: undefined };

  function resource(kind: string) {
    return class {
      readonly id: Out<string>;
      readonly arn: Out<string>;
      readonly name: Out<string>;
      readonly secret: Out<string>;
      constructor(logicalName: string, args: Record<string, unknown> = {}) {
        created.push({ kind, name: logicalName, args });
        this.id = new Out(`${logicalName}.id`);
        this.arn = new Out(`arn:test:${kind}:${logicalName}`);
        this.name = new Out(`${logicalName}.name`);
        this.secret = new Out(`${logicalName}.secret`);
      }
    };
  }
  const Client = resource("sst.aws.CognitoUserPoolClient");
  class CognitoUserPool extends resource("sst.aws.CognitoUserPool") {
    addClient(name: string, args: Record<string, unknown> = {}) {
      return new Client(name, args);
    }
  }
  const table = (name: string) => ({
    name: new Out(`${name}.name`),
    arn: new Out(`arn:aws:dynamodb:us-east-1:111122223333:table/aws-cds-hackathon-poc-reclamo-poc-${name}Table-x1`),
  });

  const globals = {
    $util: {
      output: (value: unknown) => (value instanceof Out ? value : new Out(value)),
      all: (values: unknown[]) => new Out(Promise.all(values.map(settle))),
      log: { warn: () => undefined },
    },
    sst: {
      Linkable: resource("sst.Linkable"),
      aws: { Function: resource("sst.aws.Function"), CognitoUserPool },
    },
    aws: {
      cognito: { UserGroup: resource("aws.cognito.UserGroup") },
      sesv2: {
        EmailIdentityPolicy: resource("aws.sesv2.EmailIdentityPolicy"),
        getEmailIdentity: async (args: { emailIdentity: string }) => {
          if (ses.identity === undefined || args.emailIdentity !== "reclamo.demo.craftech.io") throw new Error("AccessDeniedException");
          return ses.identity;
        },
      },
      getCallerIdentityOutput: () => ({ accountId: new Out("111122223333") }),
      getRegionOutput: () => ({ region: new Out("us-east-1") }),
    },
  };
  return { Out, deep, created, ses, table, globals };
});

vi.mock("./dns", () => ({
  appDomain: "reclamo.demo.craftech.io",
  appUrl: "https://reclamo.demo.craftech.io",
  noReplyFromAddress: "no-reply@reclamo.demo.craftech.io",
}));
vi.mock("./storage-tables", () => ({ Worlds: fake.table("Worlds"), AuditLog: fake.table("AuditLog"), Runtime: fake.table("Runtime"), Leads: fake.table("Leads") }));
// infra/leads.ts creates LeadNotifier and the alert topic; the triggers only need its link and its grants.
vi.mock("./leads", () => ({
  leadNotifier: { name: new fake.Out("LeadNotifier.name"), arn: new fake.Out("arn:test:LeadNotifier") },
  leadsPermissions: (role: string) => [{ leads: role }],
}));
// WorldJanitor by its fixed name (infra/world-janitor-link.ts), never the Function of infra/bff.ts.
vi.mock("./world-janitor-link", () => ({ WorldJanitorInvoke: { name: new fake.Out("WorldJanitorInvoke.name") } }));
// infra/storage.ts creates the buckets and the anchor log group; the trigger only needs its grants.
vi.mock("./storage", () => ({
  tableAccess: (table: string, access: string, leadingKeys?: readonly string[]) => ({ table, access, ...(leadingKeys === undefined ? {} : { leadingKeys: [...leadingKeys] }) }),
}));

for (const [name, value] of Object.entries(fake.globals)) Reflect.set(globalThis, name, value);

type AuthModule = typeof import("./auth");
type Args = Record<string, unknown>;
type Transform = (args: Args) => undefined;

async function evaluate(identity: typeof fake.ses.identity): Promise<AuthModule> {
  fake.created.length = 0;
  fake.ses.identity = identity;
  vi.resetModules();
  const module = await import("./auth");
  // Every stand-in settles in microtasks; one macrotask later all of them have, including the
  // resources created inside an `apply`.
  await new Promise((done) => setTimeout(done, 0));
  await fake.deep(fake.created.map((item) => item.args));
  return module;
}

function one(kind: string, name?: string) {
  const found = fake.created.filter((item) => item.kind === kind && (name === undefined || item.name === name));
  expect(found, `${kind} ${name ?? ""}`).toHaveLength(1);
  return found[0] as (typeof fake.created)[number];
}

function transformOf(args: Args, key: string): Transform {
  const transform = (args.transform as Record<string, unknown> | undefined)?.[key];
  expect(typeof transform, `transform.${key}`).toBe("function");
  return transform as Transform;
}

/** What SST 4.17.1 hands the transform of the Pulumi user pool when neither `usernames` nor `aliases` is set. */
const sstPoolDefaults = (): Args => ({
  accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_phone_number", priority: 1 }, { name: "verified_email", priority: 2 }] },
  adminCreateUserConfig: { allowAdminCreateUserOnly: false },
  usernameConfiguration: { caseSensitive: false },
  autoVerifiedAttributes: [],
  emailConfiguration: { emailSendingAccount: "COGNITO_DEFAULT" },
  userPoolAddOns: { advancedSecurityMode: "OFF" },
  mfaConfiguration: "OPTIONAL",
  softwareTokenMfaConfiguration: { enabled: true },
});

/** What SST 4.17.1 hands the transform of a Pulumi user pool client. */
const sstClientDefaults = (name: string): Args => ({
  name,
  userPoolId: "ConsoleUserPool.id",
  allowedOauthFlows: ["implicit", "code"],
  allowedOauthFlowsUserPoolClient: true,
  allowedOauthScopes: ["profile", "phone", "email", "openid", "aws.cognito.signin.user.admin"],
  callbackUrls: ["https://example.com"],
  supportedIdentityProviders: ["COGNITO"],
});

async function transformedPool(): Promise<Args> {
  const pool = one("sst.aws.CognitoUserPool", "ConsoleUserPool");
  const args = sstPoolDefaults();
  transformOf(pool.args, "userPool")(args);
  return (await fake.deep(args)) as Args;
}

async function transformedClient(name: string): Promise<Args> {
  const client = one("sst.aws.CognitoUserPoolClient", name);
  const args = sstClientDefaults(name);
  transformOf(client.args, "client")(args);
  return (await fake.deep(args)) as Args;
}

type Grant = { table?: TableName; access?: Access; leadingKeys?: readonly string[]; leads?: string; actions?: string[]; conditions?: Array<{ values: string[] }> };
const grantsOf = (fn: string): Grant[] => one("sst.aws.Function", fn).args.permissions as Grant[];
const linkNames = async (fn: string): Promise<string[]> => ((await fake.deep(one("sst.aws.Function", fn).args.link)) as Array<{ name: string }>).map((link) => link.name);

describe("console user pool (docs/architecture.md §11, docs/architecture-guests.md §2) [FL-094]", () => {
  let auth: AuthModule;
  beforeAll(async () => {
    auth = await evaluate(undefined);
  });

  it("is username-based: no usernames, no aliases, case-insensitive usernames", async () => {
    const pool = one("sst.aws.CognitoUserPool", "ConsoleUserPool");
    expect(pool.args).not.toHaveProperty("usernames");
    expect(pool.args).not.toHaveProperty("aliases");
    const args = await transformedPool();
    expect(args.usernameAttributes).toBeUndefined();
    expect(args.aliasAttributes).toBeUndefined();
    expect(args.usernameConfiguration).toEqual({ caseSensitive: false });
  });

  it("is on the ESSENTIALS plan, password sign-in only, 12 characters with upper, lower and a number", async () => {
    const args = await transformedPool();
    expect(args.userPoolTier).toBe("ESSENTIALS");
    expect(args.signInPolicy).toEqual({ allowedFirstAuthFactors: ["PASSWORD"] });
    expect(args.passwordPolicy).toEqual({ minimumLength: 12, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: false, temporaryPasswordValidityDays: 7 });
    expect(args.deletionProtection).toBe("INACTIVE");
  });

  it("keeps email an optional standard attribute and custom:worldId immutable", async () => {
    const args = await transformedPool();
    expect(args.schemas).toEqual([
      { name: "worldId", attributeDataType: "String", mutable: false, required: false, developerOnlyAttribute: false, stringAttributeConstraints: { minLength: "1", maxLength: String(WORLD_ID_MAX_LENGTH) } },
    ]);
    expect(JSON.stringify(args.schemas)).not.toContain("email");
  });

  it("allows the self sign-up the pre-sign-up trigger fences, and verifies the email by code", async () => {
    const { invitationTemplate } = await import("./auth-email");
    const args = await transformedPool();
    expect(args.adminCreateUserConfig).toEqual({ allowAdminCreateUserOnly: false, inviteMessageTemplate: { ...invitationTemplate } });
    expect(args.autoVerifiedAttributes).toEqual(["email"]);
  });

  it("recovers by verified email only (only a self-signup guest holds one)", async () => {
    expect((await transformedPool()).accountRecoverySetting).toEqual({ recoveryMechanisms: [{ name: "verified_email", priority: 1 }] });
  });

  it("offers TOTP as optional MFA and nothing else", () => {
    const pool = one("sst.aws.CognitoUserPool");
    expect(pool.args.mfa).toBe("optional");
    expect(pool.args.softwareToken).toBe(true);
    expect(pool.args).not.toHaveProperty("sms");
  });

  it("has exactly the four staff groups", async () => {
    const groups = fake.created.filter((item) => item.kind === "aws.cognito.UserGroup");
    const names = (await fake.deep(groups.map((group) => group.args.name))) as string[];
    expect([...names].sort()).toEqual([...StaffRole.options].sort());
    expect([...auth.STAFF_GROUPS].sort()).toEqual([...StaffRole.options].sort());
  });
});

describe("app clients [FL-094]", () => {
  beforeAll(async () => {
    await evaluate(undefined);
  });

  it("ConsoleClient: SRP and refresh only, no hosted UI, no secret, 15-minute tokens, revocable", async () => {
    const args = await transformedClient("ConsoleClient");
    expect(args.explicitAuthFlows).toEqual(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(args).toMatchObject({ allowedOauthFlowsUserPoolClient: false, allowedOauthFlows: [], allowedOauthScopes: [], callbackUrls: [], generateSecret: false, preventUserExistenceErrors: "ENABLED", enableTokenRevocation: true });
    expect(args).toMatchObject({ idTokenValidity: 15, accessTokenValidity: 15, refreshTokenValidity: 12, tokenValidityUnits: { idToken: "minutes", accessToken: "minutes", refreshToken: "hours" } });
  });

  it("ServerClient: ADMIN_USER_PASSWORD_AUTH only (IAM callers), 15-minute tokens", async () => {
    const args = await transformedClient("ServerClient");
    expect(args.explicitAuthFlows).toEqual(["ALLOW_ADMIN_USER_PASSWORD_AUTH"]);
    expect(args).toMatchObject({ allowedOauthFlowsUserPoolClient: false, generateSecret: false, idTokenValidity: 15, accessTokenValidity: 15 });
  });

  it("GuestSignupClient: confidential, refresh as its only flow set explicitly, reads email and email_verified, writes only email", async () => {
    const args = await transformedClient("GuestSignupClient");
    // An empty or missing list would enable SRP, CUSTOM_AUTH and refresh by default.
    expect(args.explicitAuthFlows).toEqual(["ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(args.generateSecret).toBe(true);
    expect(args.readAttributes).toEqual(["email", "email_verified"]);
    expect(args.writeAttributes).toEqual(["email"]);
    expect(args).toMatchObject({ allowedOauthFlowsUserPoolClient: false, allowedOauthFlows: [], allowedOauthScopes: [], preventUserExistenceErrors: "ENABLED", idTokenValidity: 15 });
  });

  it("never lets an app client write custom:worldId", async () => {
    for (const name of ["ConsoleClient", "ServerClient", "GuestSignupClient"]) {
      const args = await transformedClient(name);
      expect(JSON.stringify(args), name).not.toContain("custom:worldId");
      expect(args.allowedOauthScopes, name).not.toContain("aws.cognito.signin.user.admin");
    }
  });
});

describe("triggers (docs/architecture-guests.md §3, §12) [FL-094]", () => {
  beforeAll(async () => {
    await evaluate(undefined);
  });

  it("wires the four triggers, pre-token as V2_0, from packages/bff/src/auth-triggers", async () => {
    expect(await fake.deep(one("sst.aws.CognitoUserPool").args.triggers)).toEqual({
      preSignUp: "arn:test:sst.aws.Function:PreSignUpTrigger",
      postConfirmation: "arn:test:sst.aws.Function:PostConfirmationTrigger",
      customMessage: "arn:test:sst.aws.Function:CustomMessageTrigger",
      preTokenGeneration: "arn:test:sst.aws.Function:PreTokenTrigger",
      preTokenGenerationVersion: "v2",
    });
    for (const [fn, file] of [["PreTokenTrigger", "pre-token"], ["PreSignUpTrigger", "pre-sign-up"], ["PostConfirmationTrigger", "post-confirmation"], ["CustomMessageTrigger", "custom-message"]]) {
      expect(one("sst.aws.Function", fn).args.handler).toBe(`packages/bff/src/auth-triggers/${file}.handler`);
    }
  });

  it("keeps every trigger inside Cognito's 5 seconds", () => {
    for (const fn of ["PreTokenTrigger", "PreSignUpTrigger", "PostConfirmationTrigger", "CustomMessageTrigger"]) expect(Number.parseInt(String(one("sst.aws.Function", fn).args.timeout), 10), fn).toBeLessThanOrEqual(5);
  });

  it("pre-token: Worlds read, its AuditLog partitions append-only and only worldId of the lead", async () => {
    expect(await linkNames("PreTokenTrigger")).toEqual(["Worlds.name", "AuditLog.name", "Leads.name"]);
    expect(grantsOf("PreTokenTrigger")).toEqual([{ table: "Worlds", access: "read" }, { table: "AuditLog", access: "append", leadingKeys: ["W#*#AUD#*"] }, { leads: "PreTokenTrigger" }]);
    expect(expectedTables("PreTokenTrigger")).toEqual({ Worlds: "read", AuditLog: "append" });
    expect(LEADS_GRANTS.PreTokenTrigger).toEqual([{ actions: ["dynamodb:GetItem"], leadingKeys: ["LEAD#*", "QALEAD#*"], attributes: ["pk", "sk", "worldId"], select: "SPECIFIC_ATTRIBUTES" }]);
    expect(expectedActions("PreTokenTrigger")).toEqual([]);
    expect(expectedBuckets("PreTokenTrigger")).toEqual({});
    const keys = grantsOf("PreTokenTrigger").find((grant) => grant.table === "AuditLog")?.leadingKeys ?? [];
    for (const [key, allowed] of [["W#g03#AUD#e1#2026-10", true], ["W#g03#WORLD", false], ["KILL#AGENT", false]] as const) expect(keys.some((pattern) => stringLike(pattern, key)), key).toBe(allowed);
    for (const forbidden of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:Scan"]) expect([...TABLE_ACTIONS.read, ...TABLE_ACTIONS.append]).not.toContain(forbidden);
  });

  it("pre-sign-up: only the Leads table name and its LEADS_GRANTS", async () => {
    expect(await linkNames("PreSignUpTrigger")).toEqual(["Leads.name"]);
    expect(grantsOf("PreSignUpTrigger")).toEqual([{ leads: "PreSignUpTrigger" }]);
  });

  it("post-confirmation: writes only gs-* / qa-* worlds and runtime items, never deletes, invokes the janitor and the notifier", async () => {
    expect(await linkNames("PostConfirmationTrigger")).toEqual(["Leads.name", "Worlds.name", "Runtime.name", "AuditLog.name", "LeadNotifier.name", "WorldJanitorInvoke.name"]);
    const grants = grantsOf("PostConfirmationTrigger");
    expect(grants[0]).toEqual({ leads: "PostConfirmationTrigger" });
    for (const grant of grants.slice(1, 3)) {
      expect(grant.actions).toEqual(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]);
      expect(grant.conditions?.[0]?.values).toEqual(["W#gs-*", "W#qa-*"]);
    }
    expect(grants[3]).toEqual({ table: "AuditLog", access: "append", leadingKeys: [...WORLD_LEADING_KEYS.PostConfirmationTrigger.write] });
    expect(JSON.stringify(grants)).not.toMatch(/DeleteItem|BatchWriteItem|Scan|secret/i);
    expect(one("sst.aws.Function", "PostConfirmationTrigger").args).not.toHaveProperty("environment");
  });

  it("custom message: no link and no permission", () => {
    const trigger = one("sst.aws.Function", "CustomMessageTrigger");
    for (const key of ["link", "permissions", "environment"]) expect(trigger.args).not.toHaveProperty(key);
  });
});

describe("what the pool hands to the Bff, the QaDriver, the scripts and the console", () => {
  beforeAll(async () => {
    await evaluate(undefined);
  });

  it("links `Auth` with exactly what packages/bff/src/auth/config.ts reads, and no permission", async () => {
    const link = one("sst.Linkable", "Auth");
    expect(link.args).not.toHaveProperty("include");
    expect(await fake.deep(link.args.properties)).toEqual({ userPoolId: "ConsoleUserPool.id", consoleClientId: "ConsoleClient.id", serverClientId: "ServerClient.id", region: "us-east-1" });
    const config = readFileSync(resolve(process.cwd(), "packages/bff/src/auth/config.ts"), "utf8");
    expect(config).toContain('readLinked("Auth"');
  });

  it("links `GuestSignup` with the confidential client, its secret and whether the pool mails through SES", async () => {
    const link = one("sst.Linkable", "GuestSignup");
    expect(link.args).not.toHaveProperty("include");
    expect(await fake.deep(link.args.properties)).toEqual({
      userPoolId: "ConsoleUserPool.id",
      clientId: "GuestSignupClient.id",
      clientSecret: "GuestSignupClient.secret",
      region: "us-east-1",
      mailReady: false,
    });
  });

  it("gives Vite the pool and only the SRP client", async () => {
    const { authWebEnvironment } = await import("./auth");
    expect(await fake.deep(authWebEnvironment)).toEqual({ VITE_COGNITO_USER_POOL_ID: "ConsoleUserPool.id", VITE_COGNITO_CLIENT_ID: "ConsoleClient.id" });
  });
});

describe("emails through SES (two phases, docs/architecture-guests.md §2)", () => {
  const identityArn = "arn:aws:ses:us-east-1:111122223333:identity/reclamo.demo.craftech.io";

  it("keeps Cognito's default sender and the signup closed while the identity is missing or unverified", async () => {
    for (const identity of [undefined, { arn: identityArn, verifiedForSendingStatus: false }]) {
      await evaluate(identity);
      expect((await transformedPool()).emailConfiguration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
      expect(((await fake.deep(one("sst.Linkable", "GuestSignup").args.properties)) as Args).mailReady).toBe(false);
    }
  });

  it("sends through SES from no-reply@ without a configuration set once verified, and opens the signup", async () => {
    await evaluate({ arn: identityArn, verifiedForSendingStatus: true });
    expect((await transformedPool()).emailConfiguration).toEqual({ emailSendingAccount: "DEVELOPER", sourceArn: identityArn, fromEmailAddress: "Reclamo en regla <no-reply@reclamo.demo.craftech.io>" });
    expect(((await fake.deep(one("sst.Linkable", "GuestSignup").args.properties)) as Args).mailReady).toBe(true);
    // The identity's policy for this pool belongs to infra/messaging-email.ts: nothing here waits for it.
    expect(fake.created.filter((item) => item.kind === "aws.sesv2.EmailIdentityPolicy")).toEqual([]);
  });
});
