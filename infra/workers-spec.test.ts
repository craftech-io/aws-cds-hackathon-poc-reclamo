// Queues, workers and inbound Lambdas of WP-20 (docs/architecture.md §6, §7, §8.3, §12-§14,
// docs/architecture-integrations.md §3, docs/architecture-guests.md §7 and §12). The spec is checked
// against the documents; infra/workers.ts (with infra/messaging-whatsapp.ts and infra/mocks.ts) is
// evaluated against recording stand-ins of the SST and Pulumi globals, and every Lambda's generated
// links and statements are compared with infra/iam-capabilities.ts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { guestOriginOf } from "@reclamo/shared";
import { emailEventPattern } from "./messaging-email-spec";
import { WORLD_LEADING_KEYS, expectedActions, leadingKeysAllow, stringLike, type LambdaName } from "./iam-capabilities";
import { IAM_INLINE_POLICY_LIMIT, POLICY_SIZE_BUDGET, inlinePolicySize } from "./policy-size";
import { TABLES } from "./storage-keys";
import * as spec from "./workers-spec";
import { fake, loadWorkers, type Loaded } from "./workers-spec.fakes";

vi.mock("./secrets", async () => (await import("./workers-spec.fakes")).secretsModule());
vi.mock("./storage", async () => (await import("./workers-spec.fakes")).storageModule());
vi.mock("./channel-modes", () => ({ ChannelModes: { link: "ChannelModes" } }));
vi.mock("./guardrail", async () => (await import("./workers-spec.fakes")).guardrailModule());
vi.mock("./messaging-email", async () => (await import("./workers-spec.fakes")).emailModule());
const APP = "aws-cds-hackathon-poc-reclamo";
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const WP20: readonly spec.Wp20Lambda[] = Object.keys(spec.HANDLERS) as spec.Wp20Lambda[];

// One evaluation per file: after a registry reset vitest no longer applies the mock of infra/agentcore.ts
// to the dynamic import inside infra/workers.ts. The WABA-not-connected scenario lives in
// workers-spec-simulated.test.ts; everything that does not depend on the number is checked here.
let connected: Loaded;
beforeAll(async () => {
  connected = await loadWorkers({ WabaId: "waba-0123456789abcdef", WhatsAppPhoneNumberId: "phone-number-id-abcdef0123456789" });
});

describe("customer queues (docs/architecture.md §7)", () => {
  it("names every queue <app>-<stage>-<Queue>, FIFO ones with .fifo, inside the CI fence", () => {
    expect(spec.queueName(APP, "poc", "CustomerEvents")).toBe(`${APP}-poc-CustomerEvents.fifo`);
    expect(spec.queueName(APP, "poc", "SignupCustomerEventsDlq")).toBe(`${APP}-poc-SignupCustomerEventsDlq.fifo`);
    expect(spec.queueName(APP, "poc", "ScanDeadlines")).toBe(`${APP}-poc-ScanDeadlines`);
    expect(spec.queueName(APP, "poc", "AnchorWriteFailures")).toBe(`${APP}-poc-AnchorWriteFailures`);
    for (const queue of spec.CUSTOMER_QUEUES) expect(spec.queueName(APP, "poc", `${queue}Dlq`).length).toBeLessThanOrEqual(80);
  });

  it("sets visibility to six times the worker's timeout and two receives before the dead letters", () => {
    expect(spec.CUSTOMER_QUEUE_SETTINGS.visibilityTimeoutSeconds).toBe(2_160);
    expect(spec.CUSTOMER_QUEUE_SETTINGS.visibilityTimeoutSeconds).toBe(6 * spec.FUNCTION_BUDGETS.EventWorker.timeoutSeconds);
    expect(architecture).toContain("**visibilidad 2.160 s**");
    expect(architecture).toContain("`maxReceiveCount 2`");
    for (const queue of spec.CUSTOMER_QUEUES) {
      const args = fake.one(connected, "sst.aws.Queue", `${queue}Queue`);
      expect(args).toMatchObject({ fifo: { contentBasedDeduplication: false }, visibilityTimeout: "2160 seconds", dlq: { retry: 2 } });
      expect(args.transform).toMatchObject({ queue: { name: spec.queueName(APP, "poc", queue), sqsManagedSseEnabled: true } });
      expect(fake.one(connected, "sst.aws.Queue", `${queue}DlqQueue`)).toMatchObject({ fifo: true, transform: { queue: { messageRetentionSeconds: 1_209_600 } } });
    }
  });

  it("delays ScanDeadlines 120 s and gives it to MediaIntake alone", () => {
    expect(fake.one(connected, "sst.aws.Queue", "ScanDeadlinesQueue")).toMatchObject({ delay: "120 seconds", dlq: { retry: 3 } });
    expect(fake.subscriptionsOf(connected, "ScanDeadlinesQueue")).toEqual([{ subscriber: "MediaIntake", batch: { size: 1 } }]);
  });

  it("exposes each queue to producers only through its Linkable (url + SendMessage on that queue)", async () => {
    for (const name of [...spec.CUSTOMER_QUEUES, "ScanDeadlines"] as const) {
      const linkable = fake.one(connected, "sst.Linkable", name) as { include: Array<{ actions: string[]; resources: unknown[] }> };
      expect(linkable.include).toHaveLength(1);
      expect(linkable.include[0]?.actions).toEqual(["sqs:SendMessage"]);
    }
    const dlq = fake.one(connected, "sst.Linkable", "QaCustomerEventsDlq") as { include: Array<{ actions: string[] }> };
    expect(dlq.include[0]?.actions).toEqual(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]);
  });
});

describe("own queue and reserved concurrency of each worker [FL-125]", () => {
  it("reserves 30 in total, as docs/architecture.md §12 lists them", () => {
    const line = architecture.split("\n").find((text) => text.startsWith("- Concurrencia reservada:")) ?? "";
    const documented = Object.fromEntries([...line.matchAll(/`([A-Za-z]+)` (\d+)/g)].map((match) => [match[1], Number(match[2])]));
    expect(spec.RESERVED_CONCURRENCY).toEqual(documented);
    expect(Object.values(spec.RESERVED_CONCURRENCY).reduce((sum, value) => sum + value, 0)).toBe(30);
    expect(line).toContain("(30 en total)");
  });

  it("runs each worker on its own queue, capped at its reservation (signup 2, never behind demo or a gNN)", async () => {
    for (const [name, { queue }] of Object.entries(spec.WORKERS) as Array<[spec.WorkerName, { queue: spec.CustomerQueue }]>) {
      const reserved = spec.RESERVED_CONCURRENCY[name];
      expect(fake.one(connected, "sst.aws.Function", name)).toMatchObject({ handler: spec.HANDLERS.EventWorker, concurrency: { reserved }, timeout: "360 seconds" });
      expect(fake.subscriptionsOf(connected, `${queue}Queue`)).toEqual([{ subscriber: name, batch: { size: 1 }, transform: { eventSourceMapping: { scalingConfig: { maximumConcurrency: reserved } } } }]);
      const queues = await fake.linkedQueues(connected, name);
      expect(queues, name).toEqual([queue]);
      const consumer = await fake.statementsWith(connected, name, "sqs:ReceiveMessage");
      expect(consumer.map((statement) => statement.resources)).toEqual([[`arn:sqs:${queue}Queue`]]);
    }
    expect(spec.RESERVED_CONCURRENCY.SignupEventWorker).toBe(2);
    expect(spec.WORKERS.SignupEventWorker.queue).toBe("SignupCustomerEvents");
    expect(spec.QUEUE_WORLDS.CustomerEvents).not.toContain("gs-");
  });

  it("fences the signup worker's role to gs-* worlds in every world table and its buckets", async () => {
    const plan = spec.dataPlan("SignupEventWorker");
    for (const grant of plan.tables) {
      if (TABLES[grant.table].world === "none") expect(grant.leadingKeys, grant.table).toBeUndefined();
      else expect(grant.leadingKeys, grant.table).toBeDefined();
    }
    for (const world of ["demo", "g07", "gtest", "gprobe", "gs-abcdefghij", "qa-run1-sc01", "qamin", "sim-001"]) {
      const allowed = leadingKeysAllow("SignupEventWorker", [`W#${world}#COMPLAINT#cmp-1`], "write");
      expect(allowed, world).toBe(guestOriginOf(world) === "SIGNUP");
    }
    expect(plan.buckets.every((grant) => grant.prefixes?.join() === "W/gs-")).toBe(true);
    const runtimeWrites = plan.tables.filter((grant) => grant.table === "Runtime" && grant.access === "write");
    expect(runtimeWrites.flatMap((grant) => grant.leadingKeys ?? [])).toEqual([...WORLD_LEADING_KEYS.SignupEventWorker.write]);
    const generated = fake.one(connected, "sst.aws.Function", "SignupEventWorker");
    const tables = (await fake.deep(generated.permissions)) as Array<{ tables?: string[]; leadingKeys?: string[] }>;
    expect(tables.filter((statement) => statement.tables?.includes("Runtime")).map((statement) => statement.leadingKeys)).toEqual([["W#gs-*", "GLOBALCAP#SIGNUP#*"], ["W#gs-*", "GLOBALCAP#SIGNUP#*", "KILL#AGENT"]]);
    const fenced = tables.filter((statement) => statement.tables?.some((table) => TABLES[table as keyof typeof TABLES].world !== "none"));
    expect(fenced.every((statement) => statement.leadingKeys !== undefined)).toBe(true);
  });
});

describe("least privilege of every Lambda of WP-20 (infra/iam-capabilities.ts)", () => {
  it("builds the data access of each from its capability row, never Leads", () => {
    for (const fn of WP20) {
      const plan = spec.dataPlan(fn);
      expect(plan.tables.some((grant) => grant.table === "Leads"), fn).toBe(false);
      expect(new Set(plan.tables.map((grant) => grant.table)), fn).toEqual(new Set(Object.keys(fake.expectedTablesOf(fn))));
    }
  });

  it("generates exactly the declared actions once the WABA is connected", async () => {
    for (const fn of WP20) {
      const { actions, extra } = await fake.generatedActions(connected, fn);
      expect(extra, fn).toEqual([]);
      expect(actions, fn).toEqual(expectedActions(fn as LambdaName));
    }
  });

  it("sends and downloads media only on the secret's phone number", async () => {
    const media = await fake.statementsWith(connected, "InboundWhatsApp", "social-messaging:GetWhatsAppMessageMedia");
    expect(media[0]?.resources).toEqual(["arn:aws:social-messaging:us-east-1:776805327629:phone-number-id/abcdef0123456789"]);
  });

  it("lists Media only under wa/ for InboundWhatsApp", async () => {
    const [list] = await fake.statementsWith(connected, "InboundWhatsApp", "s3:ListBucket");
    expect(list).toEqual({ actions: ["s3:ListBucket"], resources: ["arn:aws:s3:::Media"], conditions: [{ test: "StringLike", variable: "s3:prefix", values: ["wa/*"] }] });
  });

  it("runs every caller of a mock under its fixed role name, and grants the mock's resource side to it", () => {
    for (const fn of ["InboundWhatsApp", "EventWorker", "SignupEventWorker", "QaEventWorker", "ScheduleDispatch"] as const) {
      expect(fake.roleName(connected, fn), fn).toBe(spec.fixedRoleName(APP, "poc", fn));
      expect(fake.permissionsTo(connected, fn).length, fn).toBeGreaterThan(0);
    }
    expect(fake.permissionsTo(connected, "ScheduleDispatch").map((name) => name.replace(/ScheduleDispatch$/, ""))).toEqual(["NetworkMockUrl", "NetworkMockInvoke"]);
  });
});

describe("size of each role's inline policy (IAM: 10,240 characters per role)", () => {
  const place = { app: APP, stage: "poc", region: "us-east-1", account: "776805327629" };

  it("keeps every Lambda's whole statement list, with ARNs of real length, under the budget that leaves room for the late links", async () => {
    expect(POLICY_SIZE_BUDGET).toBeLessThan(IAM_INLINE_POLICY_LIMIT);
    const functions = connected.created.filter((item) => item.kind === "sst.aws.Function").map((item) => item.name);
    expect(functions).toEqual(expect.arrayContaining(["EventWorker", "SignupEventWorker", "QaEventWorker", "InboundWhatsApp", "AnchorWriter"]));
    const sizes = Object.fromEntries(await Promise.all(functions.map(async (fn) => [fn, inlinePolicySize(await fake.renderedPolicy(connected, fn, place))] as const)));
    for (const [fn, size] of Object.entries(sizes)) expect(size, `${fn}: ${size} characters`).toBeLessThan(POLICY_SIZE_BUDGET);
  });

  it("gives a read-only leading key only to the tables it can name (KILL#AGENT: Runtime)", () => {
    const reads = spec.dataPlan("SignupEventWorker").tables.filter((grant) => grant.leadingKeys?.includes("KILL#AGENT"));
    expect(reads.map((grant) => grant.table)).toEqual(["Runtime"]);
    const bff = spec.dataPlan("Bff").tables.filter((grant) => grant.leadingKeys?.includes("SWITCH#SIGNUP"));
    expect(bff.map((grant) => grant.table)).toEqual(["Runtime"]);
    const qa = spec.dataPlan("QaDriver").tables.filter((grant) => grant.leadingKeys?.includes("W#gprobe#*"));
    expect(qa.length).toBeGreaterThan(1);
  });

  it("names a table's indexes only when it has some", async () => {
    const statements = await fake.renderedPolicy(connected, "SignupEventWorker", place);
    const resources = statements.flatMap((statement) => statement.resources);
    expect(resources.some((resource) => /-RuntimeTable-x+$/.test(resource))).toBe(true);
    expect(resources.some((resource) => /-RuntimeTable-x+\/index\/\*$/.test(resource))).toBe(false);
    expect(resources.some((resource) => /-ComplaintsTable-x+\/index\/\*$/.test(resource))).toBe(true);
  });
});

describe("AnchorWriter (docs/architecture.md §8.3)", () => {
  it("is the fixed role the CI boundary names, invoked asynchronously with 2 retries and a failure destination", async () => {
    expect(fake.roleName(connected, "AnchorWriter")).toBe(`${APP}-poc-anchor-writer`);
    expect(read("infra/bootstrap/ci-role.yaml")).toContain("${AppName}-${DeployStage}-anchor-writer");
    const args = fake.one(connected, "sst.aws.Function", "AnchorWriter");
    expect(args).toMatchObject({ handler: spec.HANDLERS.AnchorWriter, retries: 2 });
    const invokeConfig: { destinationConfig?: unknown } = {};
    (args.transform as { eventInvokeConfig: (value: object) => void }).eventInvokeConfig(invokeConfig);
    expect(await fake.deep(invokeConfig.destinationConfig)).toEqual({ onFailure: { destination: "arn:sqs:AnchorWriteFailuresQueue" } });
    const [send] = await fake.statementsWith(connected, "AnchorWriter", "sqs:SendMessage");
    expect(send?.resources).toEqual(["arn:sqs:AnchorWriteFailuresQueue"]);
    expect(await fake.linkNames(connected, "AnchorWriter")).toEqual(["ComplianceTape", "Register", "RegisterAnchors"]);
  });
});

describe("EmailEvents, MediaIntake and ScheduleDispatch", () => {
  it("routes the configuration set's events to EmailEvents with its own rule", async () => {
    const rule = fake.one(connected, "aws.cloudwatch.EventRule", "EmailEventsRule");
    expect(rule.name).toBe(spec.emailEventsRuleName(APP, "poc"));
    expect(JSON.parse(String(rule.eventPattern))).toEqual(emailEventPattern(`${APP}-email-poc`));
    expect(fake.one(connected, "aws.lambda.Permission", "EmailEventsInvoke")).toMatchObject({ principal: "events.amazonaws.com", action: "lambda:InvokeFunction" });
    expect(fake.label(fake.one(connected, "aws.cloudwatch.EventTarget", "EmailEventsTarget").arn)).toBe("EmailEvents");
  });

  it("exports what the other modules resolve late: mediaIntake, scheduleDispatch, anchorWriter, the queues", () => {
    for (const name of ["mediaIntake", "scheduleDispatch", "anchorWriter", "inboundWhatsApp", "CustomerEvents", "SignupCustomerEvents", "QaCustomerEvents", "ScanDeadlines", "QaCustomerEventsDlq", "anchorWriteFailures"]) {
      expect(connected.exports[name], name).toBeDefined();
    }
  });

  it("points every handler at a file that exists", () => {
    for (const fn of WP20) expect(existsSync(resolve(process.cwd(), `${spec.HANDLERS[fn].replace(/\.handler$/, "")}.ts`)), fn).toBe(true);
  });
});

describe("WhatsApp inbound topic (docs/architecture-integrations.md §3.1)", () => {
  const scope = { region: "us-east-1", account: "776805327629" };

  it("is named without the stage, signs with version 2 and feeds InboundWhatsApp", () => {
    expect(fake.topicArgs(connected)).toEqual({ name: `${APP}-wa-inbound`, signatureVersion: 2 });
    expect(read("packages/bff/src/channels/whatsapp/config.ts")).toContain(`WA_INBOUND_TOPIC_NAME = "${spec.whatsAppTopicName(APP)}"`);
    expect(fake.topicSubscriptions(connected)).toEqual([{ name: "InboundWhatsApp", subscriber: "InboundWhatsApp" }]);
    expect(fake.one(connected, "sst.aws.Function", "InboundWhatsApp")).toMatchObject({ concurrency: { reserved: 5 } });
  });

  it("lets End User Messaging Social publish only for this account and this WABA once it is connected", async () => {
    const policy = JSON.parse(await fake.topicPolicy(connected)) as { Statement: Array<{ Sid: string; Condition?: unknown; Principal: unknown }> };
    const publish = policy.Statement.find((statement) => statement.Sid === "EndUserMessagingSocialPublishesForTheWaba");
    expect(publish?.Principal).toEqual({ Service: "social-messaging.amazonaws.com" });
    expect(publish?.Condition).toEqual({ StringEquals: { "aws:SourceAccount": "776805327629" }, ArnEquals: { "aws:SourceArn": "arn:aws:social-messaging:us-east-1:776805327629:waba/0123456789abcdef" } });
  });

  it("reads the WABA and the phone number from their secrets, by id or ARN, and never echoes a bad value", () => {
    expect(spec.wabaArn(scope, "not-connected")).toBeUndefined();
    expect(spec.phoneNumberIdArn(scope, "phone-number-id-abc123")).toBe("arn:aws:social-messaging:us-east-1:776805327629:phone-number-id/abc123");
    expect(spec.wabaArn(scope, "arn:aws:social-messaging:us-east-1:776805327629:waba/abc123")).toBe("arn:aws:social-messaging:us-east-1:776805327629:waba/abc123");
    expect(() => spec.wabaArn(scope, "arn:aws:social-messaging:us-east-1:111122223333:waba/abc123")).toThrow(/WabaId/);
    expect(() => spec.phoneNumberIdArn(scope, "+5491100000000")).toThrow(/^(?!.*5491100000000).*$/);
    expect(spec.phoneStatements(undefined, spec.WHATSAPP_SEND_ACTIONS)).toEqual([]);
    expect(stringLike(spec.LIVE_MEDIA_LIST_PREFIX, "wa/demo/wamid.1/")).toBe(true);
  });
});
