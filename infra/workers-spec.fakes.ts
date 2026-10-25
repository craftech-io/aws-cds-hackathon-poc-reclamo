// Recording stand-ins of the SST and Pulumi globals and of the infra modules outside WP-20, for
// infra/workers-spec.test.ts: infra/workers.ts, infra/messaging-whatsapp.ts and infra/mocks.ts are
// evaluated against them, twice (WhatsApp not connected, then connected), and every resource they
// create is recorded with its arguments. State lives on globalThis because the module registry is
// reset between both evaluations. Not a test file: vitest only collects `*.test.ts`.
import { vi } from "vitest";
import { CAPABILITIES, LAMBDA_CAPABILITIES, expectedActions, expectedTables, type LambdaName } from "./iam-capabilities";
import { configurationSetName, sendEmailStatement } from "./messaging-email-spec";
import { MOCK_FUNCTION_NAMES } from "./mocks-spec";
import { type ArnPlace, type RenderedStatement, estimatedBucketArn, estimatedFunctionArn, estimatedLogGroupArn, estimatedOtherArn, estimatedQueueArn, estimatedTableArn } from "./policy-size";
import { ANCHOR_ACCESS, BUCKET_ACTIONS, TABLE_ACTIONS, anchorLogGroupName, leadingKeysConditions, tableHasIndexes, type IamCondition } from "./storage-keys";
import { CUSTOMER_QUEUES, QUEUE_CONSUMER_ACTIONS, queueName, type QueueName, type Wp20Lambda } from "./workers-spec";

/** Duck-typed: the module registry is reset between evaluations, so two copies of this class coexist. */
const isOut = (value: unknown): value is Out => value !== null && typeof value === "object" && "promise" in value && typeof (value as Out).apply === "function";

export class Out<T = unknown> {
  readonly promise: Promise<T>;
  label?: string;
  constructor(value: unknown) {
    this.promise = Promise.resolve(value).then((settled) => (isOut(settled) ? settled.promise : settled)) as Promise<T>;
  }
  apply<U>(fn: (value: T) => U): Out<U> {
    return new Out<U>(this.promise.then(fn));
  }
}

/** Every Output inside a value, resolved; recorded resources stay as they are. */
async function deep(value: unknown): Promise<unknown> {
  const settled: unknown = isOut(value) ? await value.promise : await value;
  if (isOut(settled)) return deep(settled);
  if (Array.isArray(settled)) return Promise.all(settled.map(deep));
  if (settled !== null && typeof settled === "object" && Object.getPrototypeOf(settled) === Object.prototype) {
    return Object.fromEntries(await Promise.all(Object.entries(settled).map(async ([key, item]) => [key, await deep(item)] as const)));
  }
  return settled;
}

interface Created {
  readonly kind: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface State {
  created: Created[];
  secretValues: Record<string, string>;
  warnings: string[];
}

const state: State = ((globalThis as { __wp20Fakes?: State }).__wp20Fakes ??= { created: [], secretValues: {}, warnings: [] });

const ARN_PREFIX: Readonly<Record<string, string>> = { "sst.aws.Function": "arn:fn", "sst.aws.Queue": "arn:sqs", "sst.aws.SnsTopic": "arn:sns", "aws.cloudwatch.EventRule": "arn:rule" };

function labelled(value: string, label: string): Out<string> {
  const out = new Out<string>(value);
  out.label = label;
  return out;
}

function resource(kind: string) {
  return class {
    readonly kind = kind;
    readonly logical: string;
    readonly args: Record<string, unknown>;
    readonly include: unknown;
    readonly arn: Out<string>;
    readonly name: Out<string>;
    readonly url: Out<string>;
    readonly nodes: { role: { arn: Out<string> } };
    constructor(logical: string, args: Record<string, unknown> = {}) {
      this.logical = logical;
      this.args = args;
      this.include = args.include;
      state.created.push({ kind, name: logical, args });
      this.arn = labelled(`${ARN_PREFIX[kind] ?? `arn:${kind}`}:${logical}`, logical);
      this.name = labelled(`${logical}-name`, logical);
      this.url = labelled(`https://${logical.toLowerCase()}.example`, logical);
      this.nodes = { role: { arn: labelled(`arn:role:${logical}`, logical) } };
    }
    subscribe(first: unknown, second?: unknown): void {
      const args = typeof first === "string" ? { subscriber: (second as Out).label } : { subscriber: (first as Out).label, ...(second as object) };
      state.created.push({ kind: `${kind}.subscribe`, name: typeof first === "string" ? first : this.logical, args });
    }
  };
}

export function installGlobals(): void {
  const globals = {
    $app: { name: "aws-cds-hackathon-poc-reclamo", stage: "poc" },
    $util: {
      output: (value: unknown) => new Out(deep(value)),
      all: (values: unknown[]) => new Out(Promise.all(values.map(deep))),
      log: { warn: (message: string) => void state.warnings.push(message) },
    },
    sst: {
      Linkable: resource("sst.Linkable"),
      aws: { Function: resource("sst.aws.Function"), Queue: resource("sst.aws.Queue"), SnsTopic: resource("sst.aws.SnsTopic"), permission: (statement: unknown) => statement },
    },
    aws: {
      getCallerIdentityOutput: () => ({ accountId: new Out("776805327629") }),
      getRegionOutput: () => ({ region: new Out("us-east-1") }),
      sns: { TopicPolicy: resource("aws.sns.TopicPolicy") },
      cloudwatch: { EventRule: resource("aws.cloudwatch.EventRule"), EventTarget: resource("aws.cloudwatch.EventTarget") },
      lambda: { Permission: resource("aws.lambda.Permission") },
    },
  };
  for (const [name, value] of Object.entries(globals)) Reflect.set(globalThis, name, value);
}

// ---- Stand-ins of the modules outside WP-20 ---------------------------------------------------------

const SECRET_NAMES = ["SessionKey", "SimEnvelopeKey", "QaSimEnvelopeKey", "PhoneHashKey", "RegisterChainKey", "WabaId", "WhatsAppPhoneNumberId", "SeedOverrides", "LeadNotifyEmail", "EdgeOriginKey"];

export function secretsModule(): Record<string, unknown> {
  return Object.fromEntries(SECRET_NAMES.map((name) => [name, { secret: name, get value() { return new Out(state.secretValues[name] ?? "a-value"); } }]));
}

export function storageModule(): Record<string, unknown> {
  return {
    tables: new Proxy({}, { get: (_target, name) => ({ table: String(name), arn: new Out(`arn:ddb:${String(name)}`) }) }),
    buckets: new Proxy({}, { get: (_target, name) => ({ bucket: String(name), arn: new Out(`arn:aws:s3:::${String(name)}`) }) }),
    RegisterAnchors: { link: "RegisterAnchors" },
    tableAccess: (table: string, access: string, leadingKeys?: readonly string[]) => ({ tables: [table], access, leadingKeys }),
    tablesAccess: (names: readonly string[], access: string, leadingKeys?: readonly string[]) => ({ tables: [...names], access, leadingKeys }),
    bucketAccess: (bucket: string, access: string, prefixes?: readonly string[]) => ({ bucket, access, prefixes }),
    anchorAccess: (access: string) => [{ anchors: access }],
  };
}

const linkWith = (link: string, actions: readonly string[]) => ({ link, include: [{ actions: [...actions] }] });

export const guardrailModule = () => ({ GuardrailG1: linkWith("GuardrailG1", ["bedrock:ApplyGuardrail"]), GuardrailG2: linkWith("GuardrailG2", ["bedrock:ApplyGuardrail"]) });
export const emailModule = () => ({ emailSender: linkWith("EmailSender", CAPABILITIES.SEND_EMAIL.actions), emailConfigurationSetName: "aws-cds-hackathon-poc-reclamo-email-poc" });
// ---- Loading and reading back -----------------------------------------------------------------------

export interface Loaded {
  readonly created: readonly Created[];
  readonly exports: Record<string, unknown>;
}

export async function loadWorkers(secretValues: Record<string, string>): Promise<Loaded> {
  vi.resetModules();
  state.created = [];
  state.secretValues = secretValues;
  installGlobals();
  // The modules of WP-31 the late links resolve, with the Linkables they must export (LATE_LINKS),
  // registered again on every evaluation.
  vi.doMock("./scheduler", () => ({ Scheduler: linkWith("Scheduler", CAPABILITIES.TIMERS.actions), DispatchScheduler: linkWith("DispatchScheduler", CAPABILITIES.TIMERS.actions) }));
  vi.doMock("./agentcore", () => ({
    Harness: linkWith("Harness", LAMBDA_CAPABILITIES.EventWorker.actions.filter((action) => action.startsWith("bedrock-agentcore:"))),
    Classifier: linkWith("Classifier", CAPABILITIES.BEDROCK_READ.actions),
  }));
  // The order of sst.config.ts: messaging-whatsapp first, whose late links import workers once evaluated.
  const whatsapp = await import("./messaging-whatsapp");
  const workers = await import("./workers");
  // Every late link settles here, before a later evaluation resets the module registry.
  await Promise.all(state.created.map((item) => deep([item.args.link, item.args.permissions])));
  return { created: [...state.created], exports: { ...workers, ...whatsapp } };
}

type Statement = { actions: string[]; resources: unknown[]; conditions?: unknown };
type Recorded = { kind?: string; logical?: string; include?: unknown };

const functionName = (fn: string): string => (Object.hasOwn(MOCK_FUNCTION_NAMES, fn) ? MOCK_FUNCTION_NAMES[fn as keyof typeof MOCK_FUNCTION_NAMES] : fn);

function one(loaded: Loaded, kind: string, name: string): Record<string, unknown> {
  const found = loaded.created.filter((item) => item.kind === kind && item.name === name);
  if (found.length !== 1) throw new Error(`expected one ${kind} ${name}, found ${found.length}`);
  return found[0]?.args ?? {};
}

async function linksOf(loaded: Loaded, fn: string): Promise<Recorded[]> {
  return (await deep(one(loaded, "sst.aws.Function", functionName(fn)).link)) as Recorded[];
}

const linkActions = (link: Recorded): string[] =>
  link.kind === "sst.aws.Function" ? ["lambda:InvokeFunction"] : Array.isArray(link.include) ? (link.include as Statement[]).flatMap((statement) => statement.actions) : [];

async function statementsOf(loaded: Loaded, fn: string): Promise<Statement[]> {
  const permissions = (await deep(one(loaded, "sst.aws.Function", functionName(fn)).permissions)) as Array<Statement | Record<string, unknown>>;
  return permissions.filter((statement): statement is Statement => Array.isArray((statement as Statement).actions));
}

/** A stand-in ARN of these fakes, as long as the real one would be. */
function realArn(place: ArnPlace, resource: string): string {
  if (resource.startsWith("arn:fn:")) return estimatedFunctionArn(place);
  if (resource.startsWith("arn:sqs:")) return estimatedQueueArn(place, queueName(place.app, place.stage, resource.slice("arn:sqs:".length).replace(/Queue$/, "") as QueueName));
  if (resource.startsWith("arn:aws:s3:::")) return `${estimatedBucketArn()}${resource.slice("arn:aws:s3:::".length).replace(/^[A-Za-z]+/, "")}`;
  if (resource.startsWith("arn:aws:")) return resource;
  return estimatedOtherArn(place);
}

/** Every statement of a Lambda's inline policy (its permissions and its links' includes), with ARNs of real length. */
async function renderedPolicy(loaded: Loaded, fn: string, place: ArnPlace): Promise<RenderedStatement[]> {
  const out: RenderedStatement[] = [];
  const permissions = (await deep(one(loaded, "sst.aws.Function", functionName(fn)).permissions)) as Array<Record<string, unknown>>;
  for (const item of permissions) {
    if (Array.isArray(item.tables)) {
      const resources = (item.tables as Array<Parameters<typeof tableHasIndexes>[0]>).flatMap((table) => {
        const arn = estimatedTableArn(place, table);
        return tableHasIndexes(table) ? [arn, `${arn}/index/*`] : [arn];
      });
      const leadingKeys = item.leadingKeys as string[] | undefined;
      out.push({ actions: TABLE_ACTIONS[item.access as keyof typeof TABLE_ACTIONS], resources, ...(leadingKeys ? { conditions: leadingKeysConditions(leadingKeys) } : {}) });
    } else if (typeof item.bucket === "string") {
      const prefixes = (item.prefixes as string[] | undefined) ?? [""];
      out.push({ actions: BUCKET_ACTIONS[item.access as keyof typeof BUCKET_ACTIONS], resources: prefixes.map((prefix) => `${estimatedBucketArn()}/${prefix}*`) });
    } else if (typeof item.anchors === "string") {
      const arn = estimatedLogGroupArn(place, anchorLogGroupName(place.app, place.stage));
      for (const grant of ANCHOR_ACCESS[item.anchors as keyof typeof ANCHOR_ACCESS]) out.push({ actions: grant.actions, resources: grant.streams === undefined ? [arn, `${arn}:*`] : [`${arn}:log-stream:${grant.streams}`] });
    } else if (Array.isArray(item.actions)) {
      out.push({ actions: item.actions as string[], resources: (item.resources as string[]).map((resource) => realArn(place, resource)), ...(item.conditions ? { conditions: item.conditions as IamCondition[] } : {}) });
    }
  }
  for (const link of (await linksOf(loaded, fn)) as Array<Recorded & { link?: string }>) {
    if (link.kind === "sst.aws.Function") out.push({ actions: ["lambda:InvokeFunction"], resources: [estimatedFunctionArn(place)] });
    else if (link.link === "EmailSender") out.push(sendEmailStatement(place, configurationSetName(place.app, place.stage)));
    else if (Array.isArray(link.include)) {
      for (const statement of (await deep(link.include)) as Array<Partial<Statement>>) {
        const resources = Array.isArray(statement.resources) && statement.resources.length > 0 ? (statement.resources as string[]).map((resource) => realArn(place, resource)) : [estimatedOtherArn(place)];
        out.push({ actions: statement.actions ?? [], resources, ...(statement.conditions ? { conditions: statement.conditions as IamCondition[] } : {}) });
      }
    }
  }
  return out;
}

export const fake = {
  renderedPolicy,
  deep,
  one,
  expectedTablesOf: (fn: Wp20Lambda) => expectedTables(fn as LambdaName),
  label: (value: unknown): string | undefined => (isOut(value) ? value.label : undefined),
  subscriptionsOf: (loaded: Loaded, queue: string) => loaded.created.filter((item) => item.kind === "sst.aws.Queue.subscribe" && item.name === queue).map((item) => item.args),
  topicSubscriptions: (loaded: Loaded) => loaded.created.filter((item) => item.kind === "sst.aws.SnsTopic.subscribe").map((item) => ({ name: item.name, ...item.args })),
  topicArgs(loaded: Loaded): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    (one(loaded, "sst.aws.SnsTopic", "WhatsAppInbound").transform as { topic: (value: object) => void }).topic(args);
    return args;
  },
  topicPolicy: async (loaded: Loaded) => String(await deep(one(loaded, "aws.sns.TopicPolicy", "WhatsAppInboundPolicy").policy)),
  roleName(loaded: Loaded, fn: string): unknown {
    const args: { name?: unknown } = {};
    (one(loaded, "sst.aws.Function", fn).transform as { role: (value: object) => void }).role(args);
    return args.name;
  },
  permissionsTo: (loaded: Loaded, fn: string) => loaded.created.filter((item) => item.kind === "aws.lambda.Permission" && /^(Core|Network)Mock(Url|Invoke)/.test(item.name) && item.name.endsWith(fn)).map((item) => item.name),
  async linkedQueues(loaded: Loaded, fn: string): Promise<string[]> {
    return (await linksOf(loaded, fn)).map((link) => link.logical ?? "").filter((name) => (CUSTOMER_QUEUES as readonly string[]).includes(name) || name === "ScanDeadlines");
  },
  async linkNames(loaded: Loaded, fn: string): Promise<string[]> {
    return (await linksOf(loaded, fn)).map((link) => String(link.logical ?? (link as Record<string, unknown>).table ?? (link as Record<string, unknown>).bucket ?? (link as Record<string, unknown>).link ?? (link as Record<string, unknown>).secret)).sort();
  },
  async statementsWith(loaded: Loaded, fn: string, action: string): Promise<Statement[]> {
    return (await statementsOf(loaded, fn)).filter((statement) => statement.actions.includes(action));
  },
  /** Actions a Lambda gets from its links and its statements (the event source mapping's polling aside). */
  async generatedActions(loaded: Loaded, fn: Wp20Lambda): Promise<{ actions: string[]; extra: string[] }> {
    const fromLinks = (await linksOf(loaded, fn)).flatMap(linkActions);
    const fromStatements = (await statementsOf(loaded, fn)).flatMap((statement) => statement.actions);
    const all = [...new Set([...fromLinks, ...fromStatements])].filter((action) => !(QUEUE_CONSUMER_ACTIONS as readonly string[]).includes(action)).sort();
    const expected = new Set(expectedActions(fn as LambdaName));
    return { actions: all.filter((action) => expected.has(action)), extra: all.filter((action) => !expected.has(action)) };
  },
};
