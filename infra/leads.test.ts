import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LEADS_GRANTS, stringLike, type LeadsRole } from "./iam-capabilities";
import { GLOBAL_PARTITION_PREFIXES, TABLES, dynamoArgs } from "./storage-keys";

// infra/leads.ts only runs inside the SST program: it is evaluated against recording stand-ins of the
// SST and Pulumi globals, so the assertions are on the arguments the notifier, the topic, its policy
// and the alarms really receive (docs/architecture-guests.md §9, §10, §12).
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
  async function deep(value: unknown): Promise<unknown> {
    const awaited = await settle(value);
    if (Array.isArray(awaited)) return Promise.all(awaited.map(deep));
    if (awaited !== null && typeof awaited === "object" && Object.getPrototypeOf(awaited) === Object.prototype) {
      return Object.fromEntries(await Promise.all(Object.entries(awaited).map(async ([key, item]) => [key, await deep(item)] as const)));
    }
    return awaited;
  }
  const created: Array<{ kind: string; name: string; args: Record<string, unknown> }> = [];
  const subscriptions: Array<{ name: string; subscriber: unknown }> = [];
  function resource(kind: string) {
    return class {
      readonly arn: Out<string>;
      readonly name: Out<string>;
      constructor(logicalName: string, args: Record<string, unknown> = {}) {
        created.push({ kind, name: logicalName, args });
        this.arn = new Out(`arn:test:${kind}:${logicalName}`);
        this.name = new Out(`${logicalName}.name`);
      }
    };
  }
  class SnsTopic extends resource("sst.aws.SnsTopic") {
    subscribe(name: string, subscriber: unknown) {
      subscriptions.push({ name, subscriber });
    }
  }
  const Function = resource("sst.aws.Function");
  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new Out(Promise.all(values.map(settle)).then((resolved) => strings.reduce((text, part, index) => text + part + (index < resolved.length ? String(resolved[index]) : ""), "")));
  const globals = {
    $app: { name: "aws-cds-hackathon-poc-reclamo", stage: "poc" },
    $interpolate: interpolate,
    $util: {
      output: (value: unknown) => new Out(deep(value)),
      all: (values: unknown[]) => new Out(Promise.all(values.map(settle))),
      jsonStringify: (value: unknown) => new Out(deep(value).then((resolved) => JSON.stringify(resolved))),
      log: { warn: () => undefined },
    },
    sst: { Linkable: resource("sst.Linkable"), aws: { Function, SnsTopic } },
    aws: {
      getCallerIdentityOutput: () => ({ accountId: new Out("111122223333") }),
      getRegionOutput: () => ({ region: new Out("us-east-1") }),
      sns: { TopicPolicy: resource("aws.sns.TopicPolicy") },
      cloudwatch: { MetricAlarm: resource("aws.cloudwatch.MetricAlarm") },
    },
  };
  const table = (name: string) => ({ name: new Out(`${name}.name`), arn: new Out(`arn:aws:dynamodb:us-east-1:111122223333:table/app-poc-${name}Table-x1`) });
  return { Out, deep, created, subscriptions, globals, table, Function };
});

vi.mock("./dns", () => ({ appDomain: "reclamo.demo.craftech.io", appUrl: "https://reclamo.demo.craftech.io", noReplyFromAddress: "no-reply@reclamo.demo.craftech.io" }));
vi.mock("./secrets", () => ({ LeadNotifyEmail: { name: "LeadNotifyEmail" } }));
vi.mock("./storage-tables", () => ({ Leads: fake.table("Leads"), Runtime: fake.table("Runtime"), AuditLog: fake.table("AuditLog") }));
vi.mock("./storage", () => ({ tableAccess: (table: string, access: string, leadingKeys?: readonly string[]) => ({ table, access, leadingKeys }) }));
vi.mock("./bff", () => ({ budgetBreaker: new fake.Function("BudgetBreaker") }));

for (const [name, value] of Object.entries(fake.globals)) Reflect.set(globalThis, name, value);

type Statement = { actions: string[]; resources: string[]; conditions: Array<{ test: string; variable: string; values: string[] }> };
const condition = (statement: Statement, test: string, variable: string) => statement.conditions.find((entry) => entry.test === test && entry.variable === variable)?.values;
const one = (kind: string, name: string) => {
  const found = fake.created.filter((item) => item.kind === kind && item.name === name);
  expect(found, `${kind} ${name}`).toHaveLength(1);
  return found[0] as (typeof fake.created)[number];
};

let leads: typeof import("./leads");
beforeAll(async () => {
  leads = await import("./leads");
  await new Promise((done) => setTimeout(done, 0));
});

const statementsOf = async (role: LeadsRole): Promise<Statement[]> => (await fake.deep(leads.leadsPermissions(role, "arn:leads"))) as Statement[];

describe("the Leads table (docs/architecture-guests.md §10)", () => {
  it("has no point-in-time recovery, TTL, and keys-only ByEmailHash and BySub indexes", () => {
    expect(TABLES.Leads).toMatchObject({ world: "none", ttl: true, backups: false });
    expect(dynamoArgs(TABLES.Leads)).toMatchObject({
      ttl: "expiresAt",
      globalIndexes: { ByEmailHash: { hashKey: "emailHashKey", projection: "keys-only" }, BySub: { hashKey: "subKey", projection: "keys-only" } },
    });
    const tables = readFileSync(resolve(process.cwd(), "infra/storage-tables.ts"), "utf8");
    expect(tables).toContain("spec.backups === false");
    expect(tables).toContain("args.pointInTimeRecovery = { enabled: false }");
  });

  it("holds requests, the current request per email, the canonical counter, leads and deletion proofs", () => {
    expect(GLOBAL_PARTITION_PREFIXES.Leads).toEqual(expect.arrayContaining(["SIGNUP#", "PENDING#", "CANON#", "LEAD#", "LEADDEL#", "QASIGNUP#", "QAPENDING#", "QALEAD#"]));
    expect(leads.Leads).toBeDefined();
  });

  it("warns to export the leads before an sst remove", () => {
    const readme = readFileSync(resolve(process.cwd(), "infra/bootstrap/README.md"), "utf8");
    expect(readme).toMatch(/Leads[^\n]*removed with the stage/);
    expect(readme).toContain("npm run leads:export");
  });
});

describe("leadsPermissions: least privilege on Leads (docs/architecture-guests.md §12)", () => {
  it("fences every statement by leading key with the Null guard", async () => {
    for (const role of Object.keys(LEADS_GRANTS) as LeadsRole[]) {
      for (const statement of await statementsOf(role)) {
        expect(condition(statement, "ForAllValues:StringLike", "dynamodb:LeadingKeys"), role).toBeDefined();
        expect(condition(statement, "Null", "dynamodb:LeadingKeys"), role).toEqual(["false"]);
        expect(statement.actions.join(), role).not.toMatch(/Scan|Batch|\*/);
      }
    }
  });

  it("never lets the Bff read a lead: no GetItem on LEAD#, and Query only on ByEmailHash, keys only", async () => {
    const statements = await statementsOf("Bff");
    for (const statement of statements) {
      if (condition(statement, "ForAllValues:StringLike", "dynamodb:LeadingKeys")?.some((pattern) => stringLike(pattern, "LEAD#sub-1"))) {
        expect(statement.actions).not.toContain("dynamodb:GetItem");
        expect(statement.actions).not.toContain("dynamodb:Query");
      }
    }
    const query = statements.filter((statement) => statement.actions.includes("dynamodb:Query"));
    expect(query).toHaveLength(1);
    expect(query[0]?.resources).toEqual(["arn:leads/index/ByEmailHash"]);
    expect(condition(query[0] as Statement, "StringEqualsIfExists", "dynamodb:Select")).toEqual(["ALL_PROJECTED_ATTRIBUTES"]);
  });

  it("lets the pre-token trigger read only pk, sk and worldId of a lead (never the email)", async () => {
    const [statement] = await statementsOf("PreTokenTrigger");
    expect(statement?.actions).toEqual(["dynamodb:GetItem"]);
    expect(condition(statement as Statement, "ForAllValues:StringEquals", "dynamodb:Attributes")).toEqual(["pk", "sk", "worldId"]);
    expect(condition(statement as Statement, "Null", "dynamodb:Attributes")).toEqual(["false"]);
    // GetItem carries no dynamodb:Select: a plain StringEquals would deny every read.
    expect(condition(statement as Statement, "StringEqualsIfExists", "dynamodb:Select")).toEqual(["SPECIFIC_ATTRIBUTES"]);
  });
});

describe("LeadNotifier (docs/architecture-guests.md §9) [FL-126]", () => {
  it("runs the WP-54 entry, never retried, with the table names, its secret and its sender, and no pipeline", async () => {
    const fn = one("sst.aws.Function", "LeadNotifier");
    expect(fn.args.handler).toBe("packages/bff/src/handlers/lead-notifier.handler");
    expect(existsSync(resolve(process.cwd(), "packages/bff/src/handlers/lead-notifier.ts"))).toBe(true);
    expect(fn.args.retries).toBe(0);
    const links = (await fake.deep(fn.args.link)) as Array<{ name: unknown }>;
    expect(await fake.deep(links.map((link) => link.name))).toEqual(["Leads.name", "Runtime.name", "AuditLog.name", "LeadNotifyEmail", "LeadNotice.name"]);
    expect(await fake.deep(one("sst.Linkable", "LeadNotice").args.properties)).toEqual({ from: "Reclamo en regla <no-reply@reclamo.demo.craftech.io>" });
    expect(fn.args).not.toHaveProperty("environment");
  });

  it("sends only as no-reply@ of the app identity, only to @craftech.io, and counts its notices on Runtime", async () => {
    const statements = (await fake.deep(one("sst.aws.Function", "LeadNotifier").args.permissions)) as Array<Statement & { table?: string; leadingKeys?: string[] }>;
    const send = statements.find((statement) => statement.actions?.includes("ses:SendEmail")) as Statement;
    expect(send.resources).toEqual(["arn:aws:ses:us-east-1:111122223333:identity/reclamo.demo.craftech.io"]);
    expect(condition(send, "StringEquals", "ses:FromAddress")).toEqual(["no-reply@reclamo.demo.craftech.io"]);
    const recipients = condition(send, "ForAllValues:StringLike", "ses:Recipients") ?? [];
    for (const [address, allowed] of [["team@craftech.io", true], ["lead@example.com", false], ["x@mail.craftech.io", false], ["x@craftech.io.example.com", false]] as const) {
      expect(recipients.some((pattern) => stringLike(pattern, address)), address).toBe(allowed);
    }
    expect(condition(send, "Null", "ses:Recipients")).toEqual(["false"]);
    const runtime = statements.find((statement) => statement.resources?.[0]?.includes("RuntimeTable")) as Statement;
    expect(runtime.actions).toEqual(["dynamodb:UpdateItem"]);
    expect(condition(runtime, "ForAllValues:StringLike", "dynamodb:LeadingKeys")).toEqual(["LEADNOTICE#*"]);
    expect(statements.find((statement) => statement.table === "AuditLog")).toEqual({ table: "AuditLog", access: "append", leadingKeys: ["SIGNUP#AUD#*"] });
  });

  it("gives the QaDriver's notice.probe the same send, to the SES mailbox simulator's success@ only [FL-126]", async () => {
    const probe = (await fake.deep(leads.sendLeadNoticeProbe)) as Statement;
    expect(probe.actions).toEqual(["ses:SendEmail"]);
    expect(probe.resources).toEqual(["arn:aws:ses:us-east-1:111122223333:identity/reclamo.demo.craftech.io"]);
    expect(condition(probe, "StringEquals", "ses:FromAddress")).toEqual(["no-reply@reclamo.demo.craftech.io"]);
    expect(condition(probe, "ForAllValues:StringLike", "ses:Recipients")).toEqual(["success@simulator.amazonses.com"]);
    expect(condition(probe, "Null", "ses:FromAddress")).toEqual(["false"]);
  });
});

describe("SES reputation alarms close the signup (docs/architecture-guests.md §9)", () => {
  it("names the topic <app>-auth-mail-alerts and lets only those two alarms of this account publish", async () => {
    const topic = one("sst.aws.SnsTopic", "AuthMailAlerts");
    const args: Record<string, unknown> = {};
    (topic.args.transform as { topic: (args: Record<string, unknown>) => void }).topic(args);
    expect(args.name).toBe("aws-cds-hackathon-poc-reclamo-auth-mail-alerts");
    const policy = JSON.parse(String(await fake.deep(one("aws.sns.TopicPolicy", "AuthMailAlertsPolicy").args.policy))) as { Statement: Array<Record<string, any>> };
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]?.Principal).toEqual({ Service: "cloudwatch.amazonaws.com" });
    expect(policy.Statement[0]?.Action).toBe("sns:Publish");
    expect(policy.Statement[0]?.Condition).toEqual({
      StringEquals: { "aws:SourceAccount": "111122223333" },
      ArnEquals: {
        "aws:SourceArn": [
          "arn:aws:cloudwatch:us-east-1:111122223333:alarm:aws-cds-hackathon-poc-reclamo-poc-SesComplaintRate",
          "arn:aws:cloudwatch:us-east-1:111122223333:alarm:aws-cds-hackathon-poc-reclamo-poc-SesBounceRate",
        ],
      },
    });
  });

  it("alarms at a complaint rate of 0.1 % and a bounce rate of 2 % of the account, publishing to that topic", async () => {
    for (const [logical, metricName, threshold] of [["SesComplaintRateAlarm", "Reputation.ComplaintRate", 0.001], ["SesBounceRateAlarm", "Reputation.BounceRate", 0.02]] as const) {
      const alarm = await fake.deep(one("aws.cloudwatch.MetricAlarm", logical).args);
      expect(alarm).toMatchObject({ namespace: "AWS/SES", metricName, threshold, comparisonOperator: "GreaterThanOrEqualToThreshold", treatMissingData: "notBreaching" });
      expect((alarm as { alarmActions: string[] }).alarmActions).toEqual(["arn:test:sst.aws.SnsTopic:AuthMailAlerts"]);
      expect((alarm as { name: string }).name.startsWith("aws-cds-hackathon-poc-reclamo-poc-Ses")).toBe(true);
    }
  });

  it("subscribes BudgetBreaker once infra/bff.ts exports it", async () => {
    await new Promise((done) => setTimeout(done, 0));
    expect(fake.subscriptions.map((subscription) => subscription.name)).toEqual(["BudgetBreakerAuthMail"]);
    expect(await fake.deep(fake.subscriptions[0]?.subscriber)).toBe("arn:test:sst.aws.Function:BudgetBreaker");
  });
});
